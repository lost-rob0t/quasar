(in-package #:quasar.ws)

(defun register-websocket-session (server token principal workspaces
                                    &key (capabilities +default-capabilities+)
                                         (authority-kind :internal)
                                         expires-at
                                         (one-time-p nil))
  "Register a WebSocket session, optionally bounded by expiry and one-time use."
  (quasar.protocol:ensure-string token "session token" "security.unauthorized")
  (bt:with-lock-held ((websocket-server-lock server))
    (setf (gethash token (websocket-server-sessions server))
          (list :principal principal
                :authority-kind authority-kind
                :workspaces (copy-list workspaces)
                :capabilities (copy-list capabilities)
                :expires-at expires-at
                :one-time-p one-time-p)))
  token)

(defun session-expired-p (session)
  (let ((expires-at (getf session :expires-at)))
    (and expires-at
         (<= expires-at (get-universal-time)))))

(defun consume-handshake-session (server token)
  "Return a live session and atomically consume it when marked one-time."
  (when token
    (bt:with-lock-held ((websocket-server-lock server))
      (let ((session (gethash token (websocket-server-sessions server))))
        (cond
          ((null session) nil)
          ((session-expired-p session)
           (remhash token (websocket-server-sessions server))
           nil)
          (t
           (when (getf session :one-time-p)
             (remhash token (websocket-server-sessions server)))
           session))))))

(defun handshake-session (server env)
  (if (websocket-server-insecure-development-p server)
      (list :principal "insecure-development"
            :authority-kind :internal
            :workspaces '("*")
            :capabilities (websocket-server-capabilities server))
      (consume-handshake-session server (query-parameter env "session"))))
