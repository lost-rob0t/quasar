(in-package #:quasar.tests)

(defvar *autodig-registration-failures* 0)

(defmacro autodig-registration-check (form)
  `(unless ,form
     (incf *autodig-registration-failures*)
     (format *error-output* "~&FAIL autodig-registration: ~S~%" ',form)))

(defparameter +registration-secret+
  "test-internal-service-secret-0123456789")

(defun registration-handler-function ()
  (multiple-value-bind (symbol status)
      (find-symbol "HANDLE-DELEGATED-SESSION-REGISTRATION" "QUASAR.WS")
    (declare (ignore status))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun session-lookup-function ()
  (multiple-value-bind (symbol status)
      (find-symbol "LOOKUP-WEBSOCKET-SESSION" "QUASAR.WS")
    (declare (ignore status))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun registration-server ()
  (quasar.ws:make-websocket-server
   (quasar.control-plane:make-control-plane)
   :delegated-registration-secret +registration-secret+))

(defun registration-body (token principal workspaces scopes
                           &key (ttl-seconds 120) extra)
  (let ((members
          (append
           (list
            (cons "session_token" token)
            (cons "principal" principal)
            (cons "workspaces" (apply #'quasar.protocol:json-array workspaces))
            (cons "scopes" (apply #'quasar.protocol:json-array scopes))
            (cons "ttl_seconds" ttl-seconds))
           extra)))
    (quasar.protocol:encode (apply #'quasar.protocol:json-object members))))

(defun call-registration (server body &optional (secret +registration-secret+))
  (let ((handler (registration-handler-function)))
    (autodig-registration-check handler)
    (when handler
      (multiple-value-list
       (funcall handler server (format nil "Bearer ~A" secret) body)))))

(defun response-status (response)
  (first response))

(defun response-body (response)
  (third response))

(defun test-trusted-registration-mints-narrow-session ()
  (let* ((server (registration-server))
         (token "0123456789abcdef0123456789abcdef")
         (response
           (call-registration
            server
            (registration-body
             token "human-registration-1" '("shared-workspace")
             '("starintel.autodig.read")))))
    (autodig-registration-check response)
    (when response
      (autodig-registration-check (= (response-status response) 201))
      (autodig-registration-check
       (not (search token (or (response-body response) ""))))
      (autodig-registration-check
       (not (search "human-registration-1" (or (response-body response) "")))))
    (let* ((session (gethash token (quasar.ws::websocket-server-sessions server)))
           (capabilities (and session (getf session :capabilities))))
      (autodig-registration-check session)
      (when session
        (autodig-registration-check
         (string= (getf session :principal) "human-registration-1"))
        (autodig-registration-check
         (eq (getf session :authority-kind) :delegated-user))
        (autodig-registration-check (integerp (getf session :expires-at)))
        (autodig-registration-check
         (member "autodig.run.list" capabilities :test #'string=))
        (autodig-registration-check
         (not (member "autodig.run.start" capabilities :test #'string=)))))))

(defun test-registration-rejects-wrong-service-secret ()
  (let* ((server (registration-server))
         (token "11111111111111111111111111111111")
         (response
           (call-registration
            server
            (registration-body
             token "human-registration-2" '("shared-workspace")
             '("starintel.autodig.read"))
            "wrong-internal-service-secret-000000")))
    (autodig-registration-check response)
    (when response
      (autodig-registration-check (= (response-status response) 401)))
    (autodig-registration-check
     (null (gethash token (quasar.ws::websocket-server-sessions server))))))

(defun test-registration-rejects-capability-and-workspace-injection ()
  (let ((server (registration-server)))
    (let* ((cap-token "22222222222222222222222222222222")
           (response
             (call-registration
              server
              (registration-body
               cap-token "human-registration-3" '("shared-workspace")
               '("starintel.autodig.read")
               :extra
               (list
                (cons "capabilities"
                      (quasar.protocol:json-array "document.delete")))))))
      (autodig-registration-check response)
      (when response
        (autodig-registration-check (= (response-status response) 400)))
      (autodig-registration-check
       (null (gethash cap-token (quasar.ws::websocket-server-sessions server)))))
    (let* ((wild-token "33333333333333333333333333333333")
           (response
             (call-registration
              server
              (registration-body
               wild-token "human-registration-4" '("*")
               '("starintel.autodig.read")))))
      (autodig-registration-check response)
      (when response
        (autodig-registration-check (= (response-status response) 400)))
      (autodig-registration-check
       (null (gethash wild-token (quasar.ws::websocket-server-sessions server)))))))

(defun test-registration-rejects-token-replay ()
  (let* ((server (registration-server))
         (token "44444444444444444444444444444444")
         (body
           (registration-body
            token "human-registration-5" '("shared-workspace")
            '("starintel.autodig.read" "starintel.autodig.control")))
         (first-response (call-registration server body))
         (second-response (call-registration server body)))
    (autodig-registration-check first-response)
    (autodig-registration-check second-response)
    (when first-response
      (autodig-registration-check (= (response-status first-response) 201)))
    (when second-response
      (autodig-registration-check (= (response-status second-response) 409)))))

(defun test-expired-session-is-removed-before-handshake ()
  (let* ((server (registration-server))
         (token "55555555555555555555555555555555")
         (lookup (session-lookup-function)))
    (autodig-registration-check lookup)
    (call-registration
     server
     (registration-body
      token "human-registration-6" '("shared-workspace")
      '("starintel.autodig.read")))
    (let ((session (gethash token (quasar.ws::websocket-server-sessions server))))
      (autodig-registration-check session)
      (when session
        (setf (getf session :expires-at) (1- (get-universal-time)))))
    (when lookup
      (autodig-registration-check (null (funcall lookup server token))))
    (autodig-registration-check
     (null (gethash token (quasar.ws::websocket-server-sessions server))))))

(defun run-autodig-delegated-registration-tests ()
  (setf *autodig-registration-failures* 0)
  (let ((handler (registration-handler-function))
        (lookup (session-lookup-function)))
    (autodig-registration-check handler)
    (autodig-registration-check lookup)
    (when (and handler lookup)
      (test-trusted-registration-mints-narrow-session)
      (test-registration-rejects-wrong-service-secret)
      (test-registration-rejects-capability-and-workspace-injection)
      (test-registration-rejects-token-replay)
      (test-expired-session-is-removed-before-handshake)))
  (when (plusp *autodig-registration-failures*)
    (error "Auto-Dig delegated registration tests failed: ~D"
           *autodig-registration-failures*))
  t)
