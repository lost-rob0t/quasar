(in-package #:quasar.ws)

(defun runtime-code-runner-configured-p ()
  (let ((runner (uiop:getenv "QUASAR_CODE_RUNNER_BIN")))
    (and runner (plusp (length runner)))))

(defun runtime-default-capabilities ()
  "Return a fresh standard capability list for the current runtime environment.
CODE.RUN is intentionally absent unless the external isolated runner is configured."
  (let ((capabilities (copy-list +default-capabilities+)))
    (if (runtime-code-runner-configured-p)
        (adjoin "code.run" capabilities :test #'string=)
        capabilities)))

(defun make-websocket-server (plane &key (host "127.0.0.1") (port 8081)
                              (max-message-size +default-max-message-size+)
                              (allowed-origins +default-allowed-origins+)
                              (capabilities (runtime-default-capabilities))
                              (insecure-development-p nil))
  "Construct a WebSocket server with capabilities resolved at process runtime.
This redefinition preserves the normal server contract while allowing saved
images to discover an externally configured code sandbox after image creation."
  (make-instance 'websocket-server :plane plane :host host :port port
                 :max-message-size max-message-size
                 :allowed-origins allowed-origins
                 :capabilities capabilities
                 :insecure-development-p insecure-development-p))

(defun register-websocket-session (server token principal workspaces
                                    &key
                                      (capabilities (runtime-default-capabilities))
                                      (authority-kind :internal))
  "Register a session using runtime-resolved standard capabilities by default."
  (quasar.protocol:ensure-string token "session token" "security.unauthorized")
  (bt:with-lock-held ((websocket-server-lock server))
    (setf (gethash token (websocket-server-sessions server))
          (list :principal principal
                :authority-kind authority-kind
                :workspaces (copy-list workspaces)
                :capabilities (copy-list capabilities))))
  token)
