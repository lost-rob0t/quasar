(in-package #:quasar.tests)

(defvar *autodig-session-registration-failures* 0)

(defmacro autodig-session-check (form)
  `(unless ,form
     (incf *autodig-session-registration-failures*)
     (format *error-output* "~&FAIL autodig-session-registration: ~S~%" ',form)))

(defun delegated-session-registration-function ()
  (multiple-value-bind (symbol status)
      (find-symbol "REGISTER-TRUSTED-DELEGATED-AUTODIG-SESSION" "QUASAR.WS")
    (declare (ignore status))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun delegated-registration-http-function ()
  (multiple-value-bind (symbol status)
      (find-symbol "HANDLE-DELEGATED-SESSION-REGISTRATION-REQUEST" "QUASAR.WS")
    (declare (ignore status))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun handshake-session-function ()
  (symbol-function (find-symbol "HANDSHAKE-SESSION" "QUASAR.WS")))

(defun make-registration-server ()
  (quasar.ws:make-websocket-server
   (quasar.control-plane:make-control-plane)))

(defun test-registration-requires-trusted-caller ()
  (let ((function (delegated-session-registration-function)))
    (autodig-session-check function)
    (when function
      (handler-case
          (progn
            (funcall function
                     (make-registration-server)
                     nil
                     "human-a"
                     '("workspace-a")
                     '("starintel.autodig.read"))
            (autodig-session-check nil))
        (quasar.protocol:quasar-error (condition)
          (autodig-session-check
           (string= (quasar.protocol:quasar-error-code condition)
                    "security.unauthorized")))))))

(defun test-registration-rejects-capability-and-workspace-injection ()
  (let ((function (delegated-session-registration-function)))
    (when function
      (dolist (workspaces '(nil ("*") ("") ("workspace-a" 7)))
        (handler-case
            (progn
              (funcall function
                       (make-registration-server)
                       "trusted-adapter"
                       "human-a"
                       workspaces
                       '("starintel.autodig.read"))
              (autodig-session-check nil))
          (quasar.protocol:quasar-error ()
            (autodig-session-check t))))
      (handler-case
          (progn
            (funcall function
                     (make-registration-server)
                     "trusted-adapter"
                     "human-a"
                     '("workspace-a")
                     '("autodig.run.start"))
            (autodig-session-check nil))
        (quasar.protocol:quasar-error (condition)
          (autodig-session-check
           (string= (quasar.protocol:quasar-error-code condition)
                    "security.forbidden")))))))

(defun test-registration-mints-one-time-expiring-session ()
  (let* ((server (make-registration-server))
         (function (delegated-session-registration-function))
         (handshake (handshake-session-function)))
    (when function
      (let* ((registration
               (funcall function
                        server
                        "trusted-adapter"
                        "human-a"
                        '("workspace-a")
                        '("starintel.autodig.read"
                          "starintel.autodig.control")
                        :ttl-seconds 30))
             (token (getf registration :token))
             (expires-at (getf registration :expires-at))
             (env (list :query-string (format nil "session=~A" token)))
             (session (funcall handshake server env))
             (replay (funcall handshake server env)))
        (autodig-session-check (and (stringp token) (plusp (length token))))
        (autodig-session-check (integerp expires-at))
        (autodig-session-check session)
        (when session
          (autodig-session-check
           (string= (getf session :principal) "human-a"))
          (autodig-session-check
           (eq (getf session :authority-kind) :delegated-user))
          (autodig-session-check
           (member "autodig.run.start"
                   (getf session :capabilities)
                   :test #'string=)))
        (autodig-session-check (null replay))))))

(defun test-expired-registration-cannot-handshake ()
  (let* ((server (make-registration-server))
         (function (delegated-session-registration-function))
         (handshake (handshake-session-function)))
    (when function
      (let* ((registration
               (funcall function
                        server
                        "trusted-adapter"
                        "human-expired"
                        '("workspace-a")
                        '("starintel.autodig.read")
                        :ttl-seconds 0))
             (token (getf registration :token))
             (env (list :query-string (format nil "session=~A" token))))
        (autodig-session-check (null (funcall handshake server env)))))))

(defun registration-env (secret body &key (path "/internal/v1/autodig/delegated-session"))
  (list :request-method :post
        :path-info path
        :headers (list (cons "x-quasar-registration-secret" secret))
        :raw-body (make-string-input-stream body)))

(defun registration-response-status (response)
  (first response))

(defun registration-response-object (response)
  (jsown:parse (first (third response))))

(defun test-http-registration-requires-service-secret ()
  (let* ((server (make-registration-server))
         (function (delegated-registration-http-function))
         (body "{\"principal\":\"human-a\",\"workspaces\":[\"workspace-a\"],\"scopes\":[\"starintel.autodig.read\"]}"))
    (autodig-session-check function)
    (when function
      (let ((denied (funcall function server "expected-secret" "gateway-service"
                             (registration-env "wrong-secret" body))))
        (autodig-session-check (= (registration-response-status denied) 401))
        (autodig-session-check
         (null (quasar.protocol:json-value
                (registration-response-object denied) "session")))))))

(defun test-http-registration-rejects_capability_injection_and_wildcard ()
  (let* ((server (make-registration-server))
         (function (delegated-registration-http-function)))
    (when function
      (dolist (body
               '("{\"principal\":\"human-a\",\"workspaces\":[\"*\"],\"scopes\":[\"starintel.autodig.read\"]}"
                 "{\"principal\":\"human-a\",\"workspaces\":[\"workspace-a\"],\"scopes\":[\"starintel.autodig.read\"],\"capabilities\":[\"autodig.run.start\"]}"))
        (let ((response
                (funcall function server "expected-secret" "gateway-service"
                         (registration-env "expected-secret" body))))
          (autodig-session-check
           (member (registration-response-status response) '(400 403))))))))

(defun test-http-registration-mints_private_one_time_session ()
  (let* ((server (make-registration-server))
         (function (delegated-registration-http-function))
         (handshake (handshake-session-function)))
    (when function
      (let* ((body "{\"principal\":\"human-a\",\"workspaces\":[\"workspace-a\"],\"scopes\":[\"starintel.autodig.read\",\"starintel.autodig.control\"],\"ttlSeconds\":30}")
             (response
               (funcall function server "expected-secret" "gateway-service"
                        (registration-env "expected-secret" body)))
             (object (registration-response-object response))
             (token (quasar.protocol:json-value object "session"))
             (expires-at (quasar.protocol:json-value object "expiresAt")))
        (autodig-session-check (= (registration-response-status response) 201))
        (autodig-session-check (and (stringp token) (plusp (length token))))
        (autodig-session-check (integerp expires-at))
        (autodig-session-check (not (search "expected-secret" (first (third response)))))
        (let ((env (list :query-string (format nil "session=~A" token))))
          (autodig-session-check (funcall handshake server env))
          (autodig-session-check (null (funcall handshake server env))))))))

(defun test-http-registration_is_private_route_only ()
  (let* ((server (make-registration-server))
         (function (delegated-registration-http-function))
         (body "{\"principal\":\"human-a\",\"workspaces\":[\"workspace-a\"],\"scopes\":[\"starintel.autodig.read\"]}"))
    (when function
      (let ((response
              (funcall function server "expected-secret" "gateway-service"
                       (registration-env "expected-secret" body
                                         :path "/v1/bixby/autodig/session"))))
        (autodig-session-check (= (registration-response-status response) 404))))))

(defun run-autodig-delegated-session-registration-tests ()
  (setf *autodig-session-registration-failures* 0)
  (test-registration-requires-trusted-caller)
  (test-registration-rejects-capability-and-workspace-injection)
  (test-registration-mints-one-time-expiring-session)
  (test-expired-registration-cannot-handshake)
  (test-http-registration-requires-service-secret)
  (test-http-registration-rejects_capability_injection_and_wildcard)
  (test-http-registration-mints_private_one_time_session)
  (test-http-registration_is_private_route_only)
  (when (plusp *autodig-session-registration-failures*)
    (error "Auto-Dig delegated session registration tests failed: ~D"
           *autodig-session-registration-failures*))
  (format t "~&Auto-Dig delegated session registration tests passed.~%")
  t)
