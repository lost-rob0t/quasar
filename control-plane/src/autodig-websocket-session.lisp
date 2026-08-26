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

(defparameter +autodig-user-read-capabilities+
  '("autodig.status"
    "autodig.run.get"
    "autodig.run.list")
  "Read-only lifecycle commands granted by canonical StarIntel Auto-Dig read authority.")

(defparameter +autodig-user-control-capabilities+
  '("autodig.run.start"
    "autodig.run.pause"
    "autodig.run.resume"
    "autodig.run.stop")
  "Mutation commands granted by canonical StarIntel Auto-Dig control authority.")

(defun validate-explicit-workspaces (workspaces session-kind)
  (unless (and (listp workspaces)
               workspaces
               (every (lambda (workspace)
                        (and (stringp workspace) (plusp (length workspace))))
                      workspaces))
    (error 'quasar.protocol:quasar-error
           :code "security.unauthorized"
           :message (format nil "~A sessions require explicit workspaces."
                            session-kind)))
  workspaces)

(defun register-autodig-worker-session (server token principal workspaces)
  (quasar.protocol:ensure-string principal "principal" "security.unauthorized")
  (validate-explicit-workspaces workspaces "Auto-Dig worker")
  (register-websocket-session
   server token principal workspaces
   :capabilities +autodig-worker-capabilities+))

(defun delegated-autodig-capabilities (scopes)
  (unless (and (listp scopes) (every #'stringp scopes))
    (error 'quasar.protocol:quasar-error
           :code "security.unauthorized"
           :message "Delegated Auto-Dig sessions require validated StarIntel scopes."))
  (let ((capabilities nil))
    (when (member "starintel.autodig.read" scopes :test #'string=)
      (setf capabilities
            (append capabilities +autodig-user-read-capabilities+)))
    (when (member "starintel.autodig.control" scopes :test #'string=)
      (setf capabilities
            (append capabilities +autodig-user-control-capabilities+)))
    (unless capabilities
      (error 'quasar.protocol:quasar-error
             :code "security.forbidden"
             :message "The delegated principal has no Auto-Dig authority."))
    (remove-duplicates capabilities :test #'string=)))

(defun register-delegated-autodig-user-session
    (server token principal workspaces scopes)
  "Register a narrow Quasar session from an already validated StarIntel principal.

This boundary maps canonical StarIntel scopes to fixed Quasar lifecycle commands.
It does not authenticate OAuth tokens and never accepts caller-selected Quasar
capabilities. The trusted adapter that calls this function remains responsible
for validating the StarIntel credential and principal before registration."
  (quasar.protocol:ensure-string principal "principal" "security.unauthorized")
  (validate-explicit-workspaces workspaces "Delegated Auto-Dig user")
  (register-websocket-session
   server token principal workspaces
   :capabilities (delegated-autodig-capabilities scopes)))