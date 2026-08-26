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

(defparameter +delegated-autodig-session-max-ttl-seconds+ 60
  "Maximum lifetime for a delegated Auto-Dig WebSocket handshake token.")

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
   :authority-kind :internal
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
   :authority-kind :delegated-user
   :capabilities (delegated-autodig-capabilities scopes)))

(defun register-trusted-delegated-autodig-session
    (server trusted-caller principal workspaces scopes &key (ttl-seconds 30))
  "Mint a one-time short-lived delegated session from trusted adapter context.

TRUSTED-CALLER is an authenticated service identity supplied by the private
adapter boundary, never by the public command envelope. Canonical StarIntel
scopes are mapped server-side; callers cannot submit Quasar capabilities."
  (quasar.protocol:ensure-string
   trusted-caller "trusted caller" "security.unauthorized")
  (quasar.protocol:ensure-string principal "principal" "security.unauthorized")
  (validate-explicit-workspaces workspaces "Delegated Auto-Dig user")
  (when (member "*" workspaces :test #'string=)
    (error 'quasar.protocol:quasar-error
           :code "security.forbidden"
           :message "Delegated Auto-Dig sessions may not use wildcard workspaces."))
  (unless (and (integerp ttl-seconds)
               (<= 0 ttl-seconds +delegated-autodig-session-max-ttl-seconds+))
    (error 'quasar.protocol:quasar-error
           :code "security.unauthorized"
           :message "Delegated Auto-Dig session TTL is invalid."))
  (let* ((token (random-session-id))
         (expires-at (+ (get-universal-time) ttl-seconds)))
    (register-websocket-session
     server token principal workspaces
     :authority-kind :delegated-user
     :capabilities (delegated-autodig-capabilities scopes)
     :expires-at expires-at
     :one-time-p t)
    (record-audit server "delegated-session-minted"
                  :principal principal
                  :outcome "accepted")
    (list :token token :expires-at expires-at)))