(in-package #:quasar.tests)

(defvar *autodig-control-failures* 0)

(defmacro autodig-check (form)
  `(unless ,form
     (incf *autodig-control-failures*)
     (format *error-output* "~&FAIL autodig-control: ~S~%" ',form)))

(defun autodig-array-elements (value)
  (if (and (consp value) (eq (car value) :array))
      (rest value)
      value))

(defun autodig-ok-result (response)
  (and response
       (string= (status response) "ok")
       (result response)))

(defun autodig-run-id (response)
  (let ((payload (autodig-ok-result response)))
    (and payload (jsown:val payload "runId"))))

(defun start-autodig-run (plane request-id target workspace &key (id request-id))
  (call-command
   plane
   (make-envelope
    "autodig.run.start"
    (quasar.protocol:json-object
     (cons "requestId" request-id)
     (cons "target" target))
    :id id
    :workspace workspace)))

(defun get-autodig-run (plane run-id workspace &key (id "autodig-get"))
  (call-command
   plane
   (make-envelope
    "autodig.run.get"
    (quasar.protocol:json-object (cons "runId" run-id))
    :id id
    :workspace workspace)))

(defun transition-autodig-run (plane command run-id workspace id)
  (call-command
   plane
   (make-envelope
    command
    (quasar.protocol:json-object (cons "runId" run-id))
    :id id
    :workspace workspace)))

(defun worker-autodig-command (plane command run-id workspace worker-id
                               &key lease-id outcome (id command))
  (let ((payload (quasar.protocol:json-object
                  (cons "runId" run-id)
                  (cons "workerId" worker-id))))
    (when lease-id
      (quasar.protocol:object-set payload "leaseId" lease-id))
    (when outcome
      (quasar.protocol:object-set payload "outcome" outcome))
    (call-command plane (make-envelope command payload :id id :workspace workspace))))

(defun test-autodig-capabilities-are-discoverable ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((response
                  (call-command
                   plane
                   (make-envelope "system.capabilities"
                                  (quasar.protocol:empty-object)
                                  :id "autodig-capabilities")))
                (capabilities (autodig-array-elements (result response))))
           (autodig-check (string= (status response) "ok"))
           (dolist (command '("autodig.status"
                              "autodig.run.get"
                              "autodig.run.list"
                              "autodig.run.start"
                              "autodig.run.pause"
                              "autodig.run.resume"
                              "autodig.run.stop"
                              "autodig.worker.claim"
                              "autodig.worker.heartbeat"
                              "autodig.worker.complete"
                              "autodig.worker.fail"))
             (autodig-check (member command capabilities :test #'string=))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-start-returns-durable-run-id-immediately ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((response (start-autodig-run plane
                                             "bixby-retry-stable-1"
                                             "example.com"
                                             "bixby-workspace-a"
                                             :id "autodig-start"))
                (run-id (autodig-run-id response)))
           (autodig-check (string= (status response) "ok"))
           (autodig-check (and (stringp run-id) (plusp (length run-id))))
           (when run-id
             (let ((lookup (get-autodig-run plane run-id "bixby-workspace-a")))
               (autodig-check (string= (status lookup) "ok"))
               (autodig-check (string= (jsown:val (result lookup) "runId") run-id)))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-run-survives-control-plane-restart ()
  (let* ((store (quasar.store:make-memory-store))
         (first-plane (quasar.control-plane:make-control-plane :store store))
         (run-id nil))
    (quasar.control-plane:start-control-plane first-plane)
    (unwind-protect
         (setf run-id
               (autodig-run-id
                (start-autodig-run first-plane
                                   "restart-durable-1"
                                   "restart.example"
                                   "restart-workspace")))
      (quasar.control-plane:stop-control-plane first-plane))
    (autodig-check (and (stringp run-id) (plusp (length run-id))))
    (let ((second-plane (quasar.control-plane:make-control-plane :store store)))
      (quasar.control-plane:start-control-plane second-plane)
      (unwind-protect
           (let ((lookup (and run-id
                              (get-autodig-run second-plane run-id "restart-workspace"))))
             (autodig-check lookup)
             (when lookup
               (autodig-check (string= (status lookup) "ok"))
               (autodig-check (string= (jsown:val (result lookup) "runId") run-id))))
        (quasar.control-plane:stop-control-plane second-plane)))))

(defun test-autodig-run-lookup-is-workspace-scoped ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((start (start-autodig-run plane
                                          "workspace-isolation-1"
                                          "example.net"
                                          "workspace-a"
                                          :id "autodig-start-isolation"))
                (run-id (autodig-run-id start))
                (wrong-workspace
                  (and run-id
                       (get-autodig-run plane run-id "workspace-b"
                                        :id "autodig-wrong-workspace"))))
           (autodig-check (string= (status start) "ok"))
           (autodig-check wrong-workspace)
           (when wrong-workspace
             (autodig-check (string= (status wrong-workspace) "error"))
             (autodig-check (string= (error-code wrong-workspace)
                                     "autodig.run-not-found"))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-retried-start-is-idempotent ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((first (start-autodig-run plane
                                          "stable-request-42"
                                          "example.org"
                                          "workspace-retry"
                                          :id "autodig-retry-1"))
                (second (start-autodig-run plane
                                           "stable-request-42"
                                           "example.org"
                                           "workspace-retry"
                                           :id "autodig-retry-2"))
                (first-id (autodig-run-id first))
                (second-id (autodig-run-id second)))
           (autodig-check (string= (status first) "ok"))
           (autodig-check (string= (status second) "ok"))
           (autodig-check (and first-id second-id (string= first-id second-id))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-list-is-bounded-and-status-is-summary ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (progn
           (dotimes (index 4)
             (start-autodig-run plane
                                (format nil "list-request-~D" index)
                                (format nil "target-~D.example" index)
                                "list-workspace"))
           (let* ((list-response
                    (call-command
                     plane
                     (make-envelope
                      "autodig.run.list"
                      (quasar.protocol:json-object (cons "limit" 2))
                      :id "autodig-list"
                      :workspace "list-workspace")))
                  (runs (and (autodig-ok-result list-response)
                             (autodig-array-elements (result list-response))))
                  (status-response
                    (call-command
                     plane
                     (make-envelope "autodig.status"
                                    (quasar.protocol:empty-object)
                                    :id "autodig-status"
                                    :workspace "list-workspace"))))
             (autodig-check (string= (status list-response) "ok"))
             (autodig-check (= (length runs) 2))
             (autodig-check (string= (status status-response) "ok"))
             (autodig-check (= (jsown:val (result status-response) "totalRuns") 4))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-pause-resume-stop-transitions ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((start (start-autodig-run plane
                                          "transition-request-1"
                                          "transition.example"
                                          "transition-workspace"))
                (run-id (autodig-run-id start))
                (pause (and run-id
                            (transition-autodig-run
                             plane "autodig.run.pause" run-id
                             "transition-workspace" "autodig-pause")))
                (resume (and run-id
                             (transition-autodig-run
                              plane "autodig.run.resume" run-id
                              "transition-workspace" "autodig-resume")))
                (stop (and run-id
                           (transition-autodig-run
                            plane "autodig.run.stop" run-id
                            "transition-workspace" "autodig-stop")))
                (stop-retry (and run-id
                                 (transition-autodig-run
                                  plane "autodig.run.stop" run-id
                                  "transition-workspace" "autodig-stop-retry")))
                (resume-stopped (and run-id
                                     (transition-autodig-run
                                      plane "autodig.run.resume" run-id
                                      "transition-workspace" "autodig-resume-stopped"))))
           (autodig-check (string= (jsown:val (result pause) "status") "paused"))
           (autodig-check (string= (jsown:val (result resume) "status") "queued"))
           (autodig-check (string= (jsown:val (result stop) "status") "stopped"))
           (autodig-check (string= (jsown:val (result stop-retry) "status") "stopped"))
           (autodig-check (string= (status resume-stopped) "error"))
           (autodig-check (string= (error-code resume-stopped)
                                   "autodig.invalid-transition")))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-worker-claim-is-fenced-and-user-control-invalidates-lease ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((start (start-autodig-run plane
                                          "worker-claim-request"
                                          "worker.example"
                                          "worker-workspace"))
                (run-id (autodig-run-id start))
                (claim (and run-id
                            (worker-autodig-command
                             plane "autodig.worker.claim" run-id
                             "worker-workspace" "worker-a")))
                (lease-id (and (autodig-ok-result claim)
                               (jsown:val (result claim) "leaseId")))
                (duplicate-claim
                  (and run-id
                       (worker-autodig-command
                        plane "autodig.worker.claim" run-id
                        "worker-workspace" "worker-b")))
                (heartbeat
                  (and lease-id
                       (worker-autodig-command
                        plane "autodig.worker.heartbeat" run-id
                        "worker-workspace" "worker-a" :lease-id lease-id)))
                (pause
                  (and run-id
                       (transition-autodig-run
                        plane "autodig.run.pause" run-id
                        "worker-workspace" "pause-worker-run")))
                (stale-complete
                  (and lease-id
                       (worker-autodig-command
                        plane "autodig.worker.complete" run-id
                        "worker-workspace" "worker-a" :lease-id lease-id
                        :outcome (quasar.protocol:json-object
                                  (cons "summary" "should not commit")))))
                (resume
                  (and run-id
                       (transition-autodig-run
                        plane "autodig.run.resume" run-id
                        "worker-workspace" "resume-worker-run")))
                (reclaim
                  (and run-id
                       (worker-autodig-command
                        plane "autodig.worker.claim" run-id
                        "worker-workspace" "worker-c")))
                (new-lease (and (autodig-ok-result reclaim)
                                (jsown:val (result reclaim) "leaseId")))
                (complete
                  (and new-lease
                       (worker-autodig-command
                        plane "autodig.worker.complete" run-id
                        "worker-workspace" "worker-c" :lease-id new-lease
                        :outcome (quasar.protocol:json-object
                                  (cons "summary" "published"))))))
           (autodig-check (string= (status claim) "ok"))
           (autodig-check (and lease-id (plusp (length lease-id))))
           (autodig-check (string= (jsown:val (result claim) "status") "active"))
           (autodig-check (string= (status duplicate-claim) "error"))
           (autodig-check (string= (error-code duplicate-claim)
                                   "autodig.claim-conflict"))
           (autodig-check (string= (status heartbeat) "ok"))
           (autodig-check (string= (jsown:val (result pause) "status") "paused"))
           (autodig-check (string= (status stale-complete) "error"))
           (autodig-check (string= (error-code stale-complete)
                                   "autodig.stale-worker"))
           (autodig-check (string= (jsown:val (result resume) "status") "queued"))
           (autodig-check (string= (status reclaim) "ok"))
           (autodig-check (not (string= lease-id new-lease)))
           (autodig-check (string= (jsown:val (result complete) "status") "completed"))
           (autodig-check (string= (jsown:val (jsown:val (result complete) "outcome")
                                              "summary")
                                   "published")))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-autodig-control-tests ()
  (setf *autodig-control-failures* 0)
  (test-autodig-capabilities-are-discoverable)
  (test-autodig-start-returns-durable-run-id-immediately)
  (test-autodig-run-survives-control-plane-restart)
  (test-autodig-run-lookup-is-workspace-scoped)
  (test-autodig-retried-start-is-idempotent)
  (test-autodig-list-is-bounded-and-status-is-summary)
  (test-autodig-pause-resume-stop-transitions)
  (test-autodig-worker-claim-is-fenced-and-user-control-invalidates-lease)
  (when (plusp *autodig-control-failures*)
    (error "~D Auto-Dig control test(s) failed." *autodig-control-failures*))
  (format t "~&Auto-Dig control tests passed.~%")
  t)
