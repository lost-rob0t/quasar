(in-package #:quasar.control-plane)

(defparameter +autodig-default-list-limit+ 20)
(defparameter +autodig-max-list-limit+ 100)

(defun autodig-workspace-id (envelope)
  (or (quasar.protocol:command-envelope-workspace envelope) "default"))

(defun autodig-journal-workspace-id (workspace-id)
  (format nil "__autodig__:~A" workspace-id))

(defun autodig-journal-entries (plane workspace-id)
  (or (quasar.store:store-journal-entries
       (control-plane-store plane)
       (autodig-journal-workspace-id workspace-id))
      nil))

(defun autodig-run-from-event (event)
  (quasar.protocol:json-value event "run"))

(defun autodig-latest-runs (plane workspace-id)
  (let ((latest (make-hash-table :test #'equal))
        (order nil))
    (dolist (event (autodig-journal-entries plane workspace-id))
      (let* ((run (autodig-run-from-event event))
             (run-id (and run (quasar.protocol:json-value run "runId"))))
        (when run-id
          (unless (gethash run-id latest)
            (push run-id order))
          (setf (gethash run-id latest) (quasar.protocol:clone-json run)))))
    (loop for run-id in (nreverse order)
          collect (gethash run-id latest))))

(defun autodig-find-run (plane workspace-id run-id)
  (find run-id
        (autodig-latest-runs plane workspace-id)
        :key (lambda (run) (quasar.protocol:json-value run "runId"))
        :test #'string=))

(defun autodig-find-request (plane workspace-id request-id)
  (find request-id
        (autodig-latest-runs plane workspace-id)
        :key (lambda (run) (quasar.protocol:json-value run "requestId"))
        :test #'string=))

(defun autodig-require-run (plane workspace-id payload)
  (let* ((run-id (quasar.protocol:ensure-string
                  (quasar.protocol:json-value payload "runId")
                  "runId" "autodig.invalid-request"))
         (run (autodig-find-run plane workspace-id run-id)))
    (unless run
      (error 'quasar.protocol:quasar-error
             :code "autodig.run-not-found"
             :message "The Auto-Dig run does not exist in this workspace."))
    run))

(defun autodig-next-revision (plane workspace-id)
  (1+ (length (autodig-journal-entries plane workspace-id))))

(defun autodig-persist-run (plane workspace-id command run)
  (let* ((revision (autodig-next-revision plane workspace-id))
         (operation-id (next-operation-id))
         (event
           (quasar.protocol:json-object
            (cons "operationId" operation-id)
            (cons "committedRevision" revision)
            (cons "workspaceId" workspace-id)
            (cons "command" command)
            (cons "timestamp" (get-universal-time))
            (cons "run" (quasar.protocol:clone-json run)))))
    (quasar.store:append-operation
     (control-plane-store plane)
     (autodig-journal-workspace-id workspace-id)
     event)
    (quasar.protocol:clone-json run)))

(defun autodig-new-run-id ()
  (format nil "run-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defun autodig-run-status (run)
  (quasar.protocol:json-value run "status"))

(defun autodig-copy-with-status (run status)
  (let ((copy (quasar.protocol:clone-json run)))
    (quasar.protocol:object-set copy "status" status)
    (quasar.protocol:object-set copy "updatedAt" (get-universal-time))
    copy))

(defun autodig-start (plane payload envelope)
  (let* ((workspace-id (autodig-workspace-id envelope))
         (request-id (quasar.protocol:ensure-string
                      (quasar.protocol:json-value payload "requestId")
                      "requestId" "autodig.invalid-request"))
         (target (quasar.protocol:ensure-string
                  (quasar.protocol:json-value payload "target")
                  "target" "autodig.invalid-request"))
         (existing (autodig-find-request plane workspace-id request-id)))
    (when existing
      (unless (string= target (quasar.protocol:json-value existing "target"))
        (error 'quasar.protocol:quasar-error
               :code "autodig.request-conflict"
               :message "The requestId is already bound to a different Auto-Dig request."))
      (return-from autodig-start (quasar.protocol:clone-json existing)))
    (let* ((now (get-universal-time))
           (run
             (quasar.protocol:json-object
              (cons "runId" (autodig-new-run-id))
              (cons "requestId" request-id)
              (cons "workspaceId" workspace-id)
              (cons "target" target)
              (cons "status" "queued")
              (cons "enqueued" t)
              (cons "createdAt" now)
              (cons "updatedAt" now))))
      (autodig-persist-run plane workspace-id "autodig.run.start" run))))

(defun autodig-get (plane payload envelope)
  (quasar.protocol:clone-json
   (autodig-require-run plane (autodig-workspace-id envelope) payload)))

(defun autodig-normalize-limit (payload)
  (let ((limit (or (quasar.protocol:json-value payload "limit")
                   +autodig-default-list-limit+)))
    (unless (and (integerp limit) (plusp limit))
      (error 'quasar.protocol:quasar-error
             :code "autodig.invalid-request"
             :message "limit must be a positive integer."))
    (min limit +autodig-max-list-limit+)))

(defun autodig-list (plane payload envelope)
  (let* ((workspace-id (autodig-workspace-id envelope))
         (limit (autodig-normalize-limit payload))
         (runs (reverse (autodig-latest-runs plane workspace-id))))
    (apply #'quasar.protocol:json-array
           (loop for run in runs
                 repeat limit
                 collect (quasar.protocol:clone-json run)))))

(defun autodig-status (plane payload envelope)
  (declare (ignore payload))
  (let* ((workspace-id (autodig-workspace-id envelope))
         (runs (autodig-latest-runs plane workspace-id))
         (recent (car (last runs))))
    (labels ((count-status (name)
               (count name runs :key #'autodig-run-status :test #'string=)))
      (quasar.protocol:json-object
       (cons "workspaceId" workspace-id)
       (cons "totalRuns" (length runs))
       (cons "queuedRuns" (count-status "queued"))
       (cons "activeRuns" (count-status "active"))
       (cons "pausedRuns" (count-status "paused"))
       (cons "recentRun" (if recent
                              (quasar.protocol:clone-json recent)
                              :null))))))

(defun autodig-transition-allowed-p (from to)
  (or (string= from to)
      (cond
        ((string= to "paused")
         (member from '("queued" "active") :test #'string=))
        ((string= to "queued")
         (string= from "paused"))
        ((string= to "stopped")
         (member from '("queued" "active" "paused") :test #'string=))
        (t nil))))

(defun autodig-transition (plane payload envelope command target-status)
  (let* ((workspace-id (autodig-workspace-id envelope))
         (run (autodig-require-run plane workspace-id payload))
         (current-status (autodig-run-status run)))
    (unless (autodig-transition-allowed-p current-status target-status)
      (error 'quasar.protocol:quasar-error
             :code "autodig.invalid-transition"
             :message "The requested Auto-Dig run transition is not allowed."))
    (if (string= current-status target-status)
        (quasar.protocol:clone-json run)
        (autodig-persist-run
         plane workspace-id command
         (autodig-copy-with-status run target-status)))))

(defun install-autodig-commands (plane)
  (register-command plane "autodig.status"
                    (lambda (payload envelope)
                      (autodig-status plane payload envelope)))
  (register-command plane "autodig.run.get"
                    (lambda (payload envelope)
                      (autodig-get plane payload envelope)))
  (register-command plane "autodig.run.list"
                    (lambda (payload envelope)
                      (autodig-list plane payload envelope)))
  (register-command plane "autodig.run.start"
                    (lambda (payload envelope)
                      (autodig-start plane payload envelope)))
  (register-command plane "autodig.run.pause"
                    (lambda (payload envelope)
                      (autodig-transition plane payload envelope
                                          "autodig.run.pause" "paused")))
  (register-command plane "autodig.run.resume"
                    (lambda (payload envelope)
                      (autodig-transition plane payload envelope
                                          "autodig.run.resume" "queued")))
  (register-command plane "autodig.run.stop"
                    (lambda (payload envelope)
                      (autodig-transition plane payload envelope
                                          "autodig.run.stop" "stopped")))
  plane)

(defmethod initialize-instance :after ((plane control-plane) &key)
  (install-autodig-commands plane))
