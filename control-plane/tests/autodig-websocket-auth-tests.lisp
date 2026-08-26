(in-package #:quasar.tests)

(defvar *autodig-websocket-auth-failures* 0)

(defmacro autodig-ws-check (form)
  `(unless ,form
     (incf *autodig-websocket-auth-failures*)
     (format *error-output* "~&FAIL autodig-websocket-auth: ~S~%" ',form)))

(defun test-standard-websocket-session-excludes-worker-authority ()
  (dolist (command '("autodig.worker.claim"
                     "autodig.worker.heartbeat"
                     "autodig.worker.complete"
                     "autodig.worker.fail"))
    (autodig-ws-check
     (not (member command quasar.ws::+default-capabilities+ :test #'string=)))))

(defun test-autodig-worker-session-is-least-privilege ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (server (quasar.ws:make-websocket-server plane))
         (token "test-worker-session-token")
         (workspace "worker-workspace"))
    (quasar.ws:register-autodig-worker-session
     server token "scheduled-autodig-worker" (list workspace))
    (let* ((session (gethash token (quasar.ws::websocket-server-sessions server)))
           (capabilities (getf session :capabilities)))
      (autodig-ws-check session)
      (autodig-ws-check (string= (getf session :principal)
                                 "scheduled-autodig-worker"))
      (autodig-ws-check (equal (getf session :workspaces) (list workspace)))
      (autodig-ws-check (eq (getf session :authority-kind) :internal))
      (dolist (command '("autodig.status"
                         "autodig.run.get"
                         "autodig.run.list"
                         "autodig.worker.claim"
                         "autodig.worker.heartbeat"
                         "autodig.worker.complete"
                         "autodig.worker.fail"))
        (autodig-ws-check (member command capabilities :test #'string=)))
      (dolist (command '("autodig.run.start"
                         "autodig.run.pause"
                         "autodig.run.resume"
                         "autodig.run.stop"
                         "document.create"
                         "document.update"
                         "document.delete"
                         "workspace.transaction"
                         "starlang.load"))
        (autodig-ws-check (not (member command capabilities :test #'string=)))))))

(defun delegated-session-function ()
  (multiple-value-bind (symbol status)
      (find-symbol "REGISTER-DELEGATED-AUTODIG-USER-SESSION" "QUASAR.WS")
    (declare (ignore status))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun register-delegated-test-session (server token principal scopes)
  (let ((function (delegated-session-function)))
    (autodig-ws-check function)
    (when function
      (funcall function
               server token principal '("shared-workspace") scopes))))

(defun test-delegated-autodig-read-session-is-read-only ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (server (quasar.ws:make-websocket-server plane))
         (token "delegated-read"))
    (register-delegated-test-session
     server token "human-user-1" '("starintel.autodig.read"))
    (let* ((session (gethash token (quasar.ws::websocket-server-sessions server)))
           (capabilities (and session (getf session :capabilities))))
      (autodig-ws-check session)
      (when session
        (autodig-ws-check (string= (getf session :principal) "human-user-1"))
        (autodig-ws-check (equal (getf session :workspaces) '("shared-workspace")))
        (autodig-ws-check (eq (getf session :authority-kind) :delegated-user))
        (dolist (command '("autodig.status"
                           "autodig.run.get"
                           "autodig.run.list"))
          (autodig-ws-check (member command capabilities :test #'string=)))
        (dolist (command '("autodig.run.start"
                           "autodig.run.pause"
                           "autodig.run.resume"
                           "autodig.run.stop"
                           "autodig.worker.claim"
                           "autodig.worker.heartbeat"
                           "autodig.worker.complete"
                           "autodig.worker.fail"
                           "document.create"
                           "workspace.transaction"
                           "starlang.load"))
          (autodig-ws-check (not (member command capabilities :test #'string=))))))))

(defun test-delegated-autodig-control-session-is-narrow ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (server (quasar.ws:make-websocket-server plane))
         (token "delegated-control"))
    (register-delegated-test-session
     server token "human-user-2"
     '("starintel.autodig.read" "starintel.autodig.control"))
    (let* ((session (gethash token (quasar.ws::websocket-server-sessions server)))
           (capabilities (and session (getf session :capabilities))))
      (autodig-ws-check session)
      (when session
        (autodig-ws-check (eq (getf session :authority-kind) :delegated-user))
        (dolist (command '("autodig.status"
                           "autodig.run.get"
                           "autodig.run.list"
                           "autodig.run.start"
                           "autodig.run.pause"
                           "autodig.run.resume"
                           "autodig.run.stop"))
          (autodig-ws-check (member command capabilities :test #'string=)))
        (dolist (command '("autodig.worker.claim"
                           "autodig.worker.heartbeat"
                           "autodig.worker.complete"
                           "autodig.worker.fail"
                           "document.create"
                           "document.update"
                           "document.delete"
                           "workspace.transaction"
                           "starlang.load"))
          (autodig-ws-check (not (member command capabilities :test #'string=))))))))

(defun test-delegated-autodig-session-rejects-unrelated-scopes ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (server (quasar.ws:make-websocket-server plane))
         (function (delegated-session-function))
         (rejected nil))
    (autodig-ws-check function)
    (when function
      (handler-case
          (funcall function
                   server "delegated-no-autodig" "human-user-3"
                   '("shared-workspace")
                   '("documents:read" "search:read"))
        (quasar.protocol:quasar-error (condition)
          (setf rejected
                (string= (quasar.protocol:quasar-error-code condition)
                         "security.forbidden")))))
    (autodig-ws-check rejected)
    (autodig-ws-check
     (null (gethash "delegated-no-autodig"
                    (quasar.ws::websocket-server-sessions server))))))

(defun websocket-submit-function ()
  (multiple-value-bind (symbol status)
      (find-symbol "SUBMIT-CONNECTION-COMMAND" "QUASAR.WS")
    (declare (ignore status))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun test-live-websocket-dispatch-carries-trusted-principal ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (submit (websocket-submit-function)))
    (autodig-ws-check submit)
    (when submit
      (quasar.control-plane:start-control-plane plane)
      (unwind-protect
           (let* ((connection
                    (make-instance 'quasar.ws::ws-connection
                                   :id "delegated-live"
                                   :ws nil
                                   :session-id "session-live"
                                   :principal "human-live"
                                   :authority-kind :delegated-user
                                   :authorized-workspaces '("shared-workspace")
                                   :capabilities '("autodig.run.start")))
                  (response nil)
                  (encoded
                    (make-envelope
                     "autodig.run.start"
                     (quasar.protocol:json-object
                      (cons "requestId" "live-request")
                      (cons "target" "live.example"))
                     :id "live-start"
                     :workspace "shared-workspace")))
             (funcall submit
                      plane connection encoded
                      (lambda (value) (setf response value)))
             (loop until response
                   for index below 1000
                   do (sleep 0.01))
             (autodig-ws-check (response-ok-p response))
             (when response
               (autodig-ws-check (not (search "human-live" response))))
             (let ((other-response nil))
               (funcall submit
                        plane
                        (make-instance 'quasar.ws::ws-connection
                                       :id "delegated-other"
                                       :ws nil
                                       :session-id "session-other"
                                       :principal "human-other"
                                       :authority-kind :delegated-user
                                       :authorized-workspaces '("shared-workspace")
                                       :capabilities '("autodig.run.get"))
                        (make-envelope
                         "autodig.run.get"
                         (quasar.protocol:json-object
                          (cons "runId" (autodig-run-id response)))
                         :id "live-cross-user"
                         :workspace "shared-workspace")
                        (lambda (value) (setf other-response value)))
               (loop until other-response
                     for index below 1000
                     do (sleep 0.01))
               (autodig-ws-check
                (response-error-code-is-p other-response "autodig.run-not-found"))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-autodig-websocket-auth-tests ()
  (setf *autodig-websocket-auth-failures* 0)
  (test-standard-websocket-session-excludes-worker-authority)
  (test-autodig-worker-session-is-least-privilege)
  (test-delegated-autodig-read-session-is-read-only)
  (test-delegated-autodig-control-session-is-narrow)
  (test-delegated-autodig-session-rejects-unrelated-scopes)
  (test-live-websocket-dispatch-carries-trusted-principal)
  (when (plusp *autodig-websocket-auth-failures*)
    (error "Auto-Dig WebSocket auth tests failed: ~D"
           *autodig-websocket-auth-failures*))
  t)
