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

(defun run-autodig-delegated-session-registration-tests ()
  (setf *autodig-session-registration-failures* 0)
  (test-registration-requires-trusted-caller)
  (test-registration-rejects-capability-and-workspace-injection)
  (test-registration-mints-one-time-expiring-session)
  (test-expired-registration-cannot-handshake)
  (when (plusp *autodig-session-registration-failures*)
    (error "Auto-Dig delegated session registration tests failed: ~D"
           *autodig-session-registration-failures*))
  (format t "~&Auto-Dig delegated session registration tests passed.~%")
  t)
