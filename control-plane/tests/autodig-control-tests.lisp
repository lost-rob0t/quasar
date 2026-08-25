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
                              "autodig.run.stop"))
             (autodig-check (member command capabilities :test #'string=))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-start-returns-durable-run-id-immediately ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((response
                  (call-command
                   plane
                   (make-envelope
                    "autodig.run.start"
                    (quasar.protocol:json-object
                     (cons "requestId" "bixby-retry-stable-1")
                     (cons "target" "example.com"))
                    :id "autodig-start"
                    :workspace "bixby-workspace-a")))
                (payload (and response (result response)))
                (run-id (and payload (jsown:val payload "runId"))))
           (autodig-check (string= (status response) "ok"))
           (autodig-check (and (stringp run-id) (plusp (length run-id)))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-autodig-run-lookup-is-workspace-scoped ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((start
                  (call-command
                   plane
                   (make-envelope
                    "autodig.run.start"
                    (quasar.protocol:json-object
                     (cons "requestId" "workspace-isolation-1")
                     (cons "target" "example.net"))
                    :id "autodig-start-isolation"
                    :workspace "workspace-a")))
                (run-id (and (result start)
                             (jsown:val (result start) "runId")))
                (wrong-workspace
                  (and run-id
                       (call-command
                        plane
                        (make-envelope
                         "autodig.run.get"
                         (quasar.protocol:json-object (cons "runId" run-id))
                         :id "autodig-wrong-workspace"
                         :workspace "workspace-b")))))
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
         (let* ((payload (quasar.protocol:json-object
                          (cons "requestId" "stable-request-42")
                          (cons "target" "example.org")))
                (first (call-command
                        plane
                        (make-envelope "autodig.run.start" payload
                                       :id "autodig-retry-1"
                                       :workspace "workspace-retry")))
                (second (call-command
                         plane
                         (make-envelope "autodig.run.start" payload
                                        :id "autodig-retry-2"
                                        :workspace "workspace-retry")))
                (first-id (and (result first) (jsown:val (result first) "runId")))
                (second-id (and (result second) (jsown:val (result second) "runId"))))
           (autodig-check (string= (status first) "ok"))
           (autodig-check (string= (status second) "ok"))
           (autodig-check (and first-id second-id (string= first-id second-id))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-autodig-control-tests ()
  (setf *autodig-control-failures* 0)
  (test-autodig-capabilities-are-discoverable)
  (test-autodig-start-returns-durable-run-id-immediately)
  (test-autodig-run-lookup-is-workspace-scoped)
  (test-autodig-retried-start-is-idempotent)
  (when (plusp *autodig-control-failures*)
    (error "~D Auto-Dig control test(s) failed." *autodig-control-failures*))
  (format t "~&Auto-Dig control tests passed.~%")
  t)
