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
     (not (member command quasar.ws:+default-capabilities+ :test #'string=)))))

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

(defun run-autodig-websocket-auth-tests ()
  (setf *autodig-websocket-auth-failures* 0)
  (test-standard-websocket-session-excludes-worker-authority)
  (test-autodig-worker-session-is-least-privilege)
  (when (plusp *autodig-websocket-auth-failures*)
    (error "Auto-Dig WebSocket auth tests failed: ~D"
           *autodig-websocket-auth-failures*))
  t)
