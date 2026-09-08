(in-package #:quasar.ws)

(defparameter +delegated-session-max-ttl-seconds+ 60
  "Upper bound for delegated session lifetime, regardless of requested TTL.")

(defparameter +delegated-registration-allowed-fields+
  '("session_token" "principal" "workspaces" "scopes" "ttl_seconds")
  "The only request fields the trusted registration seam accepts.")

(defun delegated-registration-secret-provided-p (authorization secret)
  "Constant-time service authorization check after length equality."
  (let ((prefix "Bearer "))
    (and (stringp authorization)
         (>= (length authorization) (+ (length prefix) 1))
         (string= authorization prefix :end1 (length prefix))
         (let ((provided (subseq authorization (length prefix))))
           (and (= (length provided) (length secret))
                (let ((diff 0))
                  (loop for provided-char across provided
                        for secret-char across secret
                        do (setf diff
                                 (logior diff
                                         (logxor (char-code provided-char)
                                                 (char-code secret-char))))
                        finally (return (zerop diff)))))))))

(defun delegated-registration-error (status code message)
  (values
   status
   nil
   (quasar.protocol:encode
    (quasar.protocol:json-object
     (cons "protocol" quasar.protocol:+protocol-version+)
     (cons "error"
           (quasar.protocol:json-object
            (cons "code" code)
            (cons "message" message)))))))

(defun delegated-error-status (code)
  (cond
    ((string= code "security.forbidden") 403)
    ((string= code "security.unauthorized") 401)
    (t 400)))

(defun parse-delegated-registration-body (body)
  (handler-case (jsown:parse body)
    (error ()
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "Registration body must be valid JSON."))))

(defun ensure-delegated-registration-field (parsed field)
  (let ((value (quasar.protocol:json-value parsed field)))
    (unless (and (stringp value) (plusp (length value)))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message (format nil "Registration field ~A must be a non-empty string."
                              field)))
    value))

(defun ensure-delegated-registration-workspaces (parsed)
  (let ((workspaces (quasar.protocol:json-value parsed "workspaces")))
    (unless (and (quasar.protocol:array-p workspaces)
                 (every (lambda (workspace)
                          (and (stringp workspace) (plusp (length workspace))
                               (not (string= workspace "*"))))
                        workspaces))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "Registration field workspaces must be a JSON array of explicit non-wildcard workspace names."))
    workspaces))

(defun ensure-delegated-registration-scopes (parsed)
  (let ((scopes (quasar.protocol:json-value parsed "scopes")))
    (unless (and (quasar.protocol:array-p scopes)
                 (every #'stringp scopes))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "Registration field scopes must be a JSON array of canonical StarIntel scopes."))
    scopes))

(defun ensure-delegated-registration-ttl (parsed)
  (let ((ttl (quasar.protocol:json-value parsed "ttl_seconds")))
    (unless (and (integerp ttl) (plusp ttl))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "Registration field ttl_seconds must be a positive integer."))
    (min ttl +delegated-session-max-ttl-seconds+)))

(defun register-delegated-registration-request (server body)
  (let* ((parsed (parse-delegated-registration-body body))
         (keys (quasar.protocol:object-keys parsed)))
    (dolist (key keys)
      (unless (member key +delegated-registration-allowed-fields+ :test #'string=)
        (error 'quasar.protocol:quasar-error
               :code "protocol.invalid-envelope"
               :message "Registration accepts only session_token, principal, workspaces, scopes, and ttl_seconds.")))
    (let* ((token (ensure-delegated-registration-field parsed "session_token"))
           (principal (ensure-delegated-registration-field parsed "principal"))
           (workspaces (ensure-delegated-registration-workspaces parsed))
           (scopes (ensure-delegated-registration-scopes parsed))
           (ttl (ensure-delegated-registration-ttl parsed)))
      (unless (<= (length token) 128)
        (error 'quasar.protocol:quasar-error
               :code "protocol.invalid-envelope"
               :message "Registration field session_token must be at most 128 characters."))
      (unless (<= (length principal) 256)
        (error 'quasar.protocol:quasar-error
               :code "protocol.invalid-envelope"
               :message "Registration field principal must be at most 256 characters."))
      (let ((capabilities (delegated-autodig-capabilities scopes)))
        (validate-explicit-workspaces workspaces "Delegated Auto-Dig user")
        (let* ((expires-at (+ (get-universal-time) ttl))
               (accepted
                (bt:with-lock-held ((websocket-server-lock server))
                  (if (gethash token (websocket-server-sessions server))
                      :replay
                      (progn
                        (setf (gethash token (websocket-server-sessions server))
                              (list :principal principal
                                    :authority-kind :delegated-user
                                    :workspaces (copy-list workspaces)
                                    :capabilities (copy-list capabilities)
                                    :expires-at expires-at))
                        :registered)))))
          (if (eq accepted :replay)
              (progn
                (record-audit server "delegated-registration"
                              :principal principal :outcome "replay-rejected")
                (delegated-registration-error
                 409 "registration.replay"
                 "The requested session token is already registered."))
              (progn
                (record-audit server "delegated-registration"
                              :principal principal :outcome "registered")
                (values
                 201
                 nil
                 (quasar.protocol:encode
                  (quasar.protocol:json-object
                   (cons "protocol" quasar.protocol:+protocol-version+)
                   (cons "status" "registered")
                   (cons "expires_in" ttl)))))))))))

(defun handle-delegated-session-registration (server authorization body)
  "Trusted private seam for StarIntel service adapters.

Registers a short-lived delegated Auto-Dig user session from an already
server-authenticated StarIntel principal. Authorization is a service secret
compared in constant time; the request is a strict allowlist and scope
mapping goes exclusively through the canonical delegated capability mapping.
Response bodies never contain the session token, the principal, or the
service secret."
  (let ((secret (websocket-server-delegated-registration-secret server)))
    (cond
      ((not (and (stringp secret) (plusp (length secret))))
       (delegated-registration-error
        404 "registration.disabled"
        "Delegated registration is not enabled on this server."))
      ((not (delegated-registration-secret-provided-p authorization secret))
       (record-audit server "delegated-registration" :outcome "unauthorized")
       (delegated-registration-error
        401 "security.unauthorized"
        "Missing or invalid service authorization."))
      (t
       (handler-case (register-delegated-registration-request server body)
         (quasar.protocol:quasar-error (error)
           (record-audit server "delegated-registration" :outcome "rejected")
           (delegated-registration-error
            (delegated-error-status (quasar.protocol:quasar-error-code error))
            (quasar.protocol:quasar-error-code error)
            (quasar.protocol:quasar-error-message error))))))))
