(in-package #:quasar.tests)

(defclass fake-auto-dig-runtime (quasar.autodig-control:auto-dig-runtime)
  ((calls :initform nil :accessor fake-auto-dig-calls)))

(defmethod quasar.autodig-control:runtime-capabilities ((runtime fake-auto-dig-runtime))
  (declare (ignore runtime))
  '("autodig.status"
    "autodig.run.get"
    "autodig.run.list"
    "autodig.run.start"
    "autodig.run.pause"
    "autodig.run.resume"
    "autodig.run.stop"))

(defmethod quasar.autodig-control:invoke-runtime
    ((runtime fake-auto-dig-runtime) command workspace-id payload)
  (push (list command workspace-id payload) (fake-auto-dig-calls runtime))
  (cond
    ((string= command "autodig.run.start")
     (quasar.protocol:json-object
      (cons "runId" "run-durable-1")
      (cons "state" "queued")))
    ((string= command "autodig.run.pause")
     (error 'quasar.protocol:quasar-error
            :code "autodig.invalid-transition"
            :message "The run cannot be paused from its current state."))
    (t
     (quasar.protocol:json-object
      (cons "ok" t)))))

(defun response-result-value (response key)
  (jsown:val (result response) key))

(defun test-autodig-capabilities-absent-without-runtime ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (let* ((response (call-command
                             plane
                             (make-envelope "system.capabilities"
                                            (quasar.protocol:empty-object))))
                  (capabilities (result response)))
             (check (string= "ok" (status response)))
             (check (not (find "autodig.run.start" capabilities :test #'string=)))
             (check (not (find "autodig.run.stop" capabilities :test #'string=)))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-runtime-installs-typed-capabilities ()
  (let* ((runtime (make-instance 'fake-auto-dig-runtime))
         (plane (quasar.control-plane:make-control-plane :auto-dig-runtime runtime)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (let* ((response (call-command
                             plane
                             (make-envelope "system.capabilities"
                                            (quasar.protocol:empty-object))))
                  (capabilities (result response)))
             (dolist (capability '("autodig.status"
                                   "autodig.run.get"
                                   "autodig.run.list"
                                   "autodig.run.start"
                                   "autodig.run.pause"
                                   "autodig.run.resume"
                                   "autodig.run.stop"))
               (check (find capability capabilities :test #'string=)))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-start-delegates-workspace-and-returns-durable-run-id ()
  (let* ((runtime (make-instance 'fake-auto-dig-runtime))
         (plane (quasar.control-plane:make-control-plane :auto-dig-runtime runtime))
         (payload (quasar.protocol:json-object
                   (cons "requestId" "request-1")
                   (cons "targetId" "target-1"))))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (let ((response (call-command
                            plane
                            (make-envelope "autodig.run.start" payload
                                           :workspace "case-17"))))
             (check (string= "ok" (status response)))
             (check (string= "run-durable-1"
                             (response-result-value response "runId")))
             (check (string= "queued"
                             (response-result-value response "state"))))
           (destructuring-bind (command workspace forwarded-payload)
               (first (fake-auto-dig-calls runtime))
             (check (string= "autodig.run.start" command))
             (check (string= "case-17" workspace))
             (check (string= "request-1"
                             (quasar.protocol:json-value forwarded-payload "requestId")))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-runtime-errors-remain-client-safe ()
  (let* ((runtime (make-instance 'fake-auto-dig-runtime))
         (plane (quasar.control-plane:make-control-plane :auto-dig-runtime runtime)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (let ((response (call-command
                            plane
                            (make-envelope "autodig.run.pause"
                                           (quasar.protocol:json-object
                                            (cons "runId" "run-1"))
                                           :workspace "case-17"))))
             (check (string= "error" (status response)))
             (check (string= "autodig.invalid-transition" (error-code response)))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-autodig-control-tests ()
  (test-autodig-capabilities-absent-without-runtime)
  (test-autodig-runtime-installs-typed-capabilities)
  (test-autodig-start-delegates-workspace-and-returns-durable-run-id)
  (test-autodig-runtime-errors-remain-client-safe)
  (when (plusp *failures*)
    (error "~D Quasar test(s) failed." *failures*))
  t)
