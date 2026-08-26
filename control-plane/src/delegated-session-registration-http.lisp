(in-package #:quasar.ws)

(defparameter +delegated-registration-path+
  "/internal/v1/autodig/delegated-session")

(defparameter +delegated-registration-max-body-bytes+ (* 16 1024))

(defvar *delegated-registration-acceptors* (make-hash-table :test #'eq))

(defun secure-string= (left right)
  "Compare two strings without data-dependent early exit after length equality."
  (and (stringp left)
       (stringp right)
       (= (length left) (length right))
       (zerop
        (loop with difference = 0
              for left-char across left
              for right-char across right
              do (setf difference
                       (logior difference
                               (logxor (char-code left-char)
                                       (char-code right-char))))
              finally (return difference)))))

(defun registration-json-response (status payload)
  (list status
        '(:content-type "application/json" :cache-control "no-store")
        (list (quasar.protocol:encode payload))))

(defun registration-error-response (status code)
  (registration-json-response
   status
   (quasar.protocol:json-object
    (cons "error"
          (quasar.protocol:json-object (cons "code" code))))))

(defun bounded-request-body-string (stream)
  (unless (streamp stream)
    (error 'quasar.protocol:quasar-error
           :code "protocol.invalid-envelope"
           :message "Registration request body is missing."))
  (let ((characters (make-array 0 :element-type 'character
                                  :adjustable t :fill-pointer 0)))
    (labels ((push-code (code)
               (when (>= (length characters) +delegated-registration-max-body-bytes+)
                 (error 'quasar.protocol:quasar-error
                        :code "protocol.invalid-envelope"
                        :message "Registration request body exceeds the size limit."))
               (unless (<= 0 code 127)
                 (error 'quasar.protocol:quasar-error
                        :code "protocol.invalid-envelope"
                        :message "Registration request must use ASCII JSON identifiers."))
               (vector-push-extend (code-char code) characters)))
      (multiple-value-bind (character-stream-p known-p)
          (subtypep (stream-element-type stream) 'character)
        (if (and known-p character-stream-p)
            (loop for value = (read-char stream nil nil)
                  while value
                  do (push-code (char-code value)))
            (loop for value = (read-byte stream nil nil)
                  while value
                  do (push-code value)))))
    (coerce characters 'string)))

(defun registration-array-of-strings (value field)
  (unless (and (listp value)
               value
               (every (lambda (item)
                        (and (stringp item) (plusp (length item))))
                      value))
    (error 'quasar.protocol:quasar-error
           :code "protocol.invalid-envelope"
           :message (format nil "~A must be a non-empty string array." field)))
  value)

(defun registration-request-payload (env)
  (handler-case
      (let ((payload
              (jsown:parse
               (bounded-request-body-string (getf env :raw-body)))))
        (unless (and (listp payload) (eq (first payload) :obj))
          (error 'quasar.protocol:quasar-error
                 :code "protocol.invalid-envelope"
                 :message "Registration request must be a JSON object."))
        payload)
    (quasar.protocol:quasar-error (condition)
      (error condition))
    (error ()
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "Registration request contains invalid JSON."))))

(defun handle-delegated-session-registration-request
    (server expected-secret trusted-caller env)
  "Handle the private service-authenticated delegated-session registration API."
  (unless (and (eq (getf env :request-method) :post)
               (string= (or (getf env :path-info) "")
                        +delegated-registration-path+))
    (return-from handle-delegated-session-registration-request
      (registration-error-response 404 "protocol.not-found")))
  (unless (and (stringp expected-secret)
               (plusp (length expected-secret))
               (secure-string= expected-secret
                               (request-header env "x-quasar-registration-secret")))
    (return-from handle-delegated-session-registration-request
      (registration-error-response 401 "security.unauthorized")))
  (handler-case
      (let* ((payload (registration-request-payload env))
             (principal
               (quasar.protocol:ensure-string
                (quasar.protocol:json-value payload "principal")
                "principal" "security.unauthorized"))
             (workspaces
               (registration-array-of-strings
                (quasar.protocol:json-value payload "workspaces") "workspaces"))
             (scopes
               (registration-array-of-strings
                (quasar.protocol:json-value payload "scopes") "scopes"))
             (ttl (quasar.protocol:json-value payload "ttlSeconds" 30)))
        (when (quasar.protocol:json-value payload "capabilities")
          (error 'quasar.protocol:quasar-error
                 :code "security.forbidden"
                 :message "Caller-selected Quasar capabilities are forbidden."))
        (let* ((registration
                 (register-trusted-delegated-autodig-session
                  server trusted-caller principal workspaces scopes
                  :ttl-seconds ttl))
               (token (getf registration :token))
               (expires-at (getf registration :expires-at)))
          (registration-json-response
           201
           (quasar.protocol:json-object
            (cons "session" token)
            (cons "expiresAt" expires-at)))))
    (quasar.protocol:quasar-error (condition)
      (let ((code (quasar.protocol:quasar-error-code condition)))
        (registration-error-response
         (cond
           ((string= code "security.unauthorized") 401)
           ((string= code "security.forbidden") 403)
           (t 400))
         code)))
    (error ()
      (registration-error-response 500 "control-plane.unavailable"))))

(defun start-delegated-session-registration-server
    (server expected-secret trusted-caller &key (host "127.0.0.1") (port 8082))
  "Start a private authenticated HTTP seam for delegated Quasar session minting."
  (quasar.protocol:ensure-string
   expected-secret "registration secret" "security.unauthorized")
  (quasar.protocol:ensure-string
   trusted-caller "trusted caller" "security.unauthorized")
  (when (gethash server *delegated-registration-acceptors*)
    (error "Delegated session registration server is already started."))
  (let ((acceptor
          (clack:clackup
           (lambda (env)
             (handle-delegated-session-registration-request
              server expected-secret trusted-caller env))
           :host host
           :port port
           :use-default-middlewares nil)))
    (setf (gethash server *delegated-registration-acceptors*) acceptor)
    acceptor))

(defun stop-delegated-session-registration-server (server)
  (let ((acceptor (gethash server *delegated-registration-acceptors*)))
    (when acceptor
      (ignore-errors (clack:stop acceptor))
      (remhash server *delegated-registration-acceptors*))
    t))
