(in-package #:quasar.plugin)

(defparameter *default-user-storage-bytes* (* 5 1024 1024 1024)
  "Default per-user local storage allowance: 5 GiB.")

(defparameter *shared-local-session-enabled* t
  "Desktop compatibility switch. Hosted init files must set this to NIL.")

(defparameter +development-origins+
  '("http://localhost:5173" "http://127.0.0.1:5173"
    "http://localhost:8080" "http://127.0.0.1:8080"))

(defparameter *websocket-allowed-origins* +development-origins+
  "Exact browser origins accepted by the WebSocket server.")

(defvar *session-registered-hooks* nil)
(defvar *request-session-resolver* nil)
(defvar *actor-spawn-authorizer* nil)
(defvar *storage-quota-resolver* nil)
(defvar *policy-lock* (bt:make-lock "quasar-plugin-policy"))

(defun add-session-registered-hook (function)
  (check-type function function)
  (bt:with-lock-held (*policy-lock*)
    (pushnew function *session-registered-hooks* :test #'eq))
  function)

(defun remove-session-registered-hook (function)
  (bt:with-lock-held (*policy-lock*)
    (setf *session-registered-hooks*
          (remove function *session-registered-hooks* :test #'eq)))
  function)

(defun notify-session-registered (principal workspaces capabilities authority-kind)
  (let ((hooks (bt:with-lock-held (*policy-lock*)
                 (copy-list *session-registered-hooks*))))
    (dolist (hook hooks)
      (funcall hook principal (copy-list workspaces)
               (copy-list capabilities) authority-kind))))

(defun set-request-session-resolver (function)
  "Install a trusted resolver called for each UI boot request.
The resolver receives the request URL and returns a browser-safe Quasar
session token or NIL. It must never return upstream API or actor credentials."
  (check-type function (or null function))
  (bt:with-lock-held (*policy-lock*)
    (setf *request-session-resolver* function)))

(defun resolve-request-session (url)
  (let ((resolver (bt:with-lock-held (*policy-lock*)
                    *request-session-resolver*)))
    (and resolver (funcall resolver url))))

(defun set-actor-spawn-authorizer (function)
  "Install the one trusted actor-spawn policy gate.
FUNCTION receives a principal and a property list describing the requested
actor, parent, sandbox, and resource limits. It must return true to allow."
  (check-type function (or null function))
  (bt:with-lock-held (*policy-lock*)
    (setf *actor-spawn-authorizer* function)))

(defun authorize-actor-spawn (principal request)
  (let ((authorizer (bt:with-lock-held (*policy-lock*)
                      *actor-spawn-authorizer*)))
    (unless (and (getf request :sandboxed-p)
                 (or (null authorizer) (funcall authorizer principal request)))
      (error "Actor spawn denied for principal ~A." principal))
    t))

(defun set-storage-quota-resolver (function)
  "Install a trusted per-principal byte-quota resolver. NIL uses 5 GiB."
  (check-type function (or null function))
  (bt:with-lock-held (*policy-lock*)
    (setf *storage-quota-resolver* function)))

(defun authorize-storage-commit (principal workspace)
  "Reject a candidate workspace that exceeds PRINCIPAL's logical byte quota.
The check happens before durable commit, so quota failures have no side effects."
  (when principal
    (let* ((resolver (bt:with-lock-held (*policy-lock*) *storage-quota-resolver*))
           (limit (if resolver (funcall resolver principal)
                      *default-user-storage-bytes*))
           (used (length (babel:string-to-octets
                          (quasar.protocol:encode
                           (quasar.workspace:workspace-snapshot workspace))))))
      (unless (and (integerp limit) (plusp limit))
        (error "Invalid storage quota for principal ~A." principal))
      (when (> used limit)
        (error 'quasar.protocol:quasar-error
               :code "storage.quota-exceeded"
               :message (format nil "Storage quota exceeded (~D of ~D bytes)."
                                used limit)))))
  t)

(defun reset-plugin-policy ()
  (bt:with-lock-held (*policy-lock*)
    (setf *session-registered-hooks* nil
          *request-session-resolver* nil
          *actor-spawn-authorizer* nil
          *storage-quota-resolver* nil
          *shared-local-session-enabled* t
          *websocket-allowed-origins* +development-origins+
          *default-user-storage-bytes* (* 5 1024 1024 1024)))
  t)
