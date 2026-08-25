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

(defun register-autodig-worker-session (server token principal workspaces)
  (quasar.protocol:ensure-string principal "principal" "security.unauthorized")
  (unless (and (listp workspaces) workspaces (every #'stringp workspaces))
    (error 'quasar.protocol:quasar-error
           :code "security.unauthorized"
           :message "Auto-Dig worker sessions require explicit workspaces."))
  (register-websocket-session
   server token principal workspaces
   :capabilities +autodig-worker-capabilities+))
