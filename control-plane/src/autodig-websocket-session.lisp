(in-package #:quasar.ws)

(defparameter +autodig-worker-capabilities+
  '("autodig.status"
    "autodig.run.get"
    "autodig.run.list"
    "autodig.worker.claim"
    "autodig.worker.heartbeat"
    "autodig.worker.complete"
    "autodig.worker.fail")
  "Least-privilege command set for scheduled Auto-Dig workers.")

(defparameter +autodig-client-capabilities+
  '("system.capabilities"
    "autodig.status"
    "autodig.run.get"
    "autodig.run.list"
    "autodig.run.start"
    "autodig.run.pause"
    "autodig.run.resume"
    "autodig.run.stop")
  "Least-privilege command set for authenticated Auto-Dig lifecycle clients.")

(defun valid-explicit-workspaces-p (workspaces)
  (and (listp workspaces)
       workspaces
       (every (lambda (workspace)
                (and (stringp workspace) (plusp (length workspace))))
              workspaces)))

(defun require-autodig-session-authority (token principal workspaces role)
  (quasar.protocol:ensure-string token "session token" "security.unauthorized")
  (quasar.protocol:ensure-string principal "principal" "security.unauthorized")
  (unless (valid-explicit-workspaces-p workspaces)
    (error 'quasar.protocol:quasar-error
           :code "security.unauthorized"
           :message (format nil "Auto-Dig ~A sessions require explicit workspaces."
                            role))))

(defun register-autodig-worker-session (server token principal workspaces)
  (require-autodig-session-authority token principal workspaces "worker")
  (register-websocket-session
   server token principal workspaces
   :capabilities +autodig-worker-capabilities+))

(defun register-autodig-client-session (server token principal workspaces)
  (require-autodig-session-authority token principal workspaces "client")
  (register-websocket-session
   server token principal workspaces
   :capabilities +autodig-client-capabilities+))
