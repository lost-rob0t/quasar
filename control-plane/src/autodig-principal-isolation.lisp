(in-package #:quasar.control-plane)

(defun autodig-delegated-principal ()
  (when (delegated-user-command-p)
    (quasar.protocol:ensure-string
     (current-command-principal) "principal" "security.unauthorized")))

(defun autodig-run-visible-p (run)
  (let ((principal (autodig-delegated-principal)))
    (or (null principal)
        (string= principal
                 (or (quasar.protocol:json-value run "ownerPrincipal") "")))))

(defun autodig-visible-runs (plane workspace-id)
  (remove-if-not #'autodig-run-visible-p
                 (autodig-latest-runs plane workspace-id)))

(defun autodig-find-visible-request (plane workspace-id request-id)
  (find request-id
        (autodig-visible-runs plane workspace-id)
        :key (lambda (run) (quasar.protocol:json-value run "requestId"))
        :test #'string=))

(defun autodig-require-run (plane workspace-id payload)
  (let* ((run-id (quasar.protocol:ensure-string
                  (quasar.protocol:json-value payload "runId")
                  "runId" "autodig.invalid-request"))
         (run (autodig-find-run plane workspace-id run-id)))
    (unless (and run (autodig-run-visible-p run))
      (error 'quasar.protocol:quasar-error
             :code "autodig.run-not-found"
             :message "The Auto-Dig run does not exist in this workspace."))
    run))

(defun autodig-start (plane payload envelope)
  (let* ((workspace-id (autodig-workspace-id envelope))
         (request-id (quasar.protocol:ensure-string
                      (quasar.protocol:json-value payload "requestId")
                      "requestId" "autodig.invalid-request"))
         (target (quasar.protocol:ensure-string
                  (quasar.protocol:json-value payload "target")
                  "target" "autodig.invalid-request"))
         (existing (autodig-find-visible-request plane workspace-id request-id)))
    (when existing
      (unless (string= target (quasar.protocol:json-value existing "target"))
        (error 'quasar.protocol:quasar-error
               :code "autodig.request-conflict"
               :message "The requestId is already bound to a different Auto-Dig request."))
      (return-from autodig-start (autodig-public-run existing)))
    (let* ((now (get-universal-time))
           (principal (autodig-delegated-principal))
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
      (when principal
        (quasar.protocol:object-set run "ownerPrincipal" principal))
      (autodig-public-run
       (autodig-persist-run plane workspace-id "autodig.run.start" run)))))

(defun autodig-list (plane payload envelope)
  (let* ((workspace-id (autodig-workspace-id envelope))
         (limit (autodig-normalize-limit payload))
         (runs (reverse (autodig-visible-runs plane workspace-id))))
    (apply #'quasar.protocol:json-array
           (loop for run in runs
                 repeat limit
                 collect (autodig-public-run run)))))

(defun autodig-status (plane payload envelope)
  (declare (ignore payload))
  (let* ((workspace-id (autodig-workspace-id envelope))
         (runs (autodig-visible-runs plane workspace-id))
         (recent (car (last runs))))
    (labels ((count-status (name)
               (count name runs :key #'autodig-run-status :test #'string=)))
      (quasar.protocol:json-object
       (cons "workspaceId" workspace-id)
       (cons "totalRuns" (length runs))
       (cons "queuedRuns" (count-status "queued"))
       (cons "activeRuns" (count-status "active"))
       (cons "pausedRuns" (count-status "paused"))
       (cons "completedRuns" (count-status "completed"))
       (cons "failedRuns" (count-status "failed"))
       (cons "stoppedRuns" (count-status "stopped"))
       (cons "recentRun" (if recent
                              (autodig-public-run recent)
                              :null))))))