(in-package #:quasar.ws)

(defvar *server* nil)

(defparameter +default-max-message-size+ (* 1024 1024)
  "Maximum message size in bytes (1 MB default).")

(defparameter +default-rate-limit-window+ 1.0
  "Rate limit window in seconds.")

(defparameter +default-rate-limit-max-commands+ 100
  "Maximum commands per connection per rate-limit window.")

(defparameter +default-allowed-origins+
  '("http://localhost:5173"
    "http://127.0.0.1:5173"
    "http://localhost:8080"
    "http://127.0.0.1:8080")
  "Default allowed Origin values for localhost development.")

(defparameter +default-capabilities+
  '("system.capabilities"
    "workspace.snapshot"
    "workspace.transaction"
    "document.list"
    "document.get"
    "document.create"
    "document.update"
    "document.delete"
    "graph.snapshot"
    "graph.workspace.put"
    "graph.workspace.delete"
    "graph.workspace.activate"
    "graph.node.create"
    "graph.node.update"
    "graph.node.delete"
    "graph.edge.create"
    "graph.edge.update"
    "graph.edge.delete"
    "starlang.status")
  "Commands allowed for standard clients. starlang.load is excluded.")

(defclass ws-connection ()
  ((id :initarg :id :reader ws-connection-id)
   (ws :initarg :ws :reader ws-connection-ws)
   (workspace :initarg :workspace :initform "default" :accessor ws-connection-workspace)
   (session-id :initarg :session-id :reader ws-connection-session-id)
   (principal :initarg :principal :initform "anonymous" :reader ws-connection-principal)
   (authorized-workspaces :initarg :authorized-workspaces
                          :reader ws-connection-authorized-workspaces)
   (capabilities :initarg :capabilities :reader ws-connection-capabilities)
   (command-count :initform 0 :accessor ws-connection-command-count)
   (window-start :initform (get-universal-time) :accessor ws-connection-window-start))
  (:documentation "Per-connection state: workspace subscription, session,
  rate-limiting counters, and principal identity."))

(defclass websocket-server ()
  ((host :initarg :host :initform "127.0.0.1" :reader websocket-server-host)
   (port :initarg :port :initform 8081 :reader websocket-server-port)
   (plane :initarg :plane :reader websocket-server-plane)
   (acceptor :initform nil :accessor websocket-server-acceptor)
   (connections :initform (make-hash-table :test #'equal)
                :reader websocket-server-connections)
   (subscriber-id :initform nil :accessor websocket-server-subscriber-id)
   (started-p :initform nil :accessor websocket-server-started-p)
   (max-message-size :initarg :max-message-size
                     :initform +default-max-message-size+
                     :reader websocket-server-max-message-size)
   (rate-limit-window :initarg :rate-limit-window
                      :initform +default-rate-limit-window+
                      :reader websocket-server-rate-limit-window)
   (rate-limit-max :initarg :rate-limit-max
                   :initform +default-rate-limit-max-commands+
                   :reader websocket-server-rate-limit-max)
   (allowed-origins :initarg :allowed-origins
                    :initform +default-allowed-origins+
                    :reader websocket-server-allowed-origins)
   (capabilities :initarg :capabilities
                 :initform +default-capabilities+
                 :reader websocket-server-capabilities)
   (sessions :initform (make-hash-table :test #'equal)
             :reader websocket-server-sessions)
   (insecure-development-p :initarg :insecure-development-p
                           :initform nil
                           :reader websocket-server-insecure-development-p)
   (audit-records :initform (make-array 0 :adjustable t :fill-pointer 0)
                  :reader websocket-server-audit-records)
   (lock :initform (bt:make-lock "quasar-websocket-server")
         :reader websocket-server-lock))
  (:documentation
   "WebSocket server carrying quasar.control.v1 envelopes both directions.
   Each connection is isolated to its selected workspace. Events are only
   delivered to connections subscribed to the same workspace. Origin
   validation, message-size limits, per-connection rate limiting, and
   command capability checks are enforced."))

(defun make-websocket-server (plane &key (host "127.0.0.1") (port 8081)
                              (max-message-size +default-max-message-size+)
                              (allowed-origins +default-allowed-origins+)
                              (capabilities +default-capabilities+)
                              (insecure-development-p nil))
  (make-instance 'websocket-server :plane plane :host host :port port
                 :max-message-size max-message-size
                 :allowed-origins allowed-origins
                 :capabilities capabilities
                 :insecure-development-p insecure-development-p))

(defun register-websocket-session (server token principal workspaces
                                    &key (capabilities +default-capabilities+))
  (quasar.protocol:ensure-string token "session token" "security.unauthorized")
  (bt:with-lock-held ((websocket-server-lock server))
    (setf (gethash token (websocket-server-sessions server))
          (list :principal principal
                :workspaces (copy-list workspaces)
                :capabilities (copy-list capabilities))))
  token)

(defun record-audit (server action &key principal workspace command outcome)
  (bt:with-lock-held ((websocket-server-lock server))
    (let ((records (websocket-server-audit-records server)))
      (when (>= (length records) 1000)
        (replace records records :start1 0 :start2 1)
        (decf (fill-pointer records)))
      (vector-push-extend
       (list :timestamp (get-universal-time)
             :action action
             :principal principal
             :workspace workspace
             :command command
             :outcome outcome)
       records))))

(defun websocket-audit-records (server)
  (bt:with-lock-held ((websocket-server-lock server))
    (copy-list (coerce (websocket-server-audit-records server) 'list))))

(defvar *resource* nil)

(defun protocol-error-envelope (id code)
  (quasar.protocol:encode
   (quasar.protocol:json-object
    (cons "protocol" quasar.protocol:+protocol-version+)
    (cons "id" (or id ""))
    (cons "status" "error")
    (cons "error"
          (quasar.protocol:json-object
           (cons "code" code))))))

(defun safe-decode-id (message)
  "Try to extract the envelope ID from a possibly-malformed message."
  (handler-case
      (let ((object (jsown:parse message)))
        (quasar.protocol:json-value object "id"))
    (error () nil)))

(defun safe-decode-workspace (message)
  "Try to extract the workspace from a possibly-malformed message."
  (handler-case
      (let* ((object (jsown:parse message))
             (metadata (quasar.protocol:json-value object "metadata"
                        (quasar.protocol:empty-object))))
        (or (quasar.protocol:json-value metadata "workspace") "default"))
    (error () "default")))

(defun safe-decode-command (message)
  "Try to extract the command name from a possibly-malformed message."
  (handler-case
      (let ((object (jsown:parse message)))
        (quasar.protocol:json-value object "command"))
    (error () nil)))

(defun origin-allowed-p (server origin)
  "Check if the Origin header is in the allowed list."
  (or (and (websocket-server-insecure-development-p server) (null origin))
      (null (websocket-server-allowed-origins server))
      (member origin (websocket-server-allowed-origins server) :test #'string=)))

(defun message-size-ok-p (server message)
  "Check if the message is within the size limit."
  (<= (length message) (websocket-server-max-message-size server)))

(defun rate-limit-ok-p (conn server)
  "Check if the connection is within the rate limit. Resets the window
  if enough time has passed."
  (let* ((now (get-universal-time))
         (elapsed (- now (ws-connection-window-start conn)))
         (window (websocket-server-rate-limit-window server)))
    (when (>= elapsed window)
      (setf (ws-connection-window-start conn) now
            (ws-connection-command-count conn) 0))
    (< (ws-connection-command-count conn)
       (websocket-server-rate-limit-max server))))

(defun command-allowed-p (connection command)
  "Check if the command is in the capabilities list."
  (member command (ws-connection-capabilities connection) :test #'string=))

(defun handle-text-message (server conn message)
  (let ((plane (websocket-server-plane server))
        (connection (ws-connection-ws conn)))
    (handler-case
        (progn
          (unless (message-size-ok-p server message)
            (error 'quasar.protocol:quasar-error
                   :code "protocol.invalid-envelope"
                   :message "Message exceeds maximum size."))
          (unless (rate-limit-ok-p conn server)
            (error 'quasar.protocol:quasar-error
                   :code "security.rate-limited"
                   :message "Rate limit exceeded."))
          (incf (ws-connection-command-count conn))
          (let ((command (safe-decode-command message)))
            (unless command
              (error 'quasar.protocol:quasar-error
                     :code "protocol.invalid-envelope"
                     :message "Command envelope is malformed."))
            (unless (command-allowed-p conn command)
              (error 'quasar.protocol:quasar-error
                     :code "security.forbidden"
                     :message (format nil "Command ~A is not permitted." command))))
          (let ((workspace (safe-decode-workspace message)))
            (unless (or (member "*" (ws-connection-authorized-workspaces conn)
                                :test #'string=)
                        (member workspace (ws-connection-authorized-workspaces conn)
                                :test #'string=))
              (error 'quasar.protocol:quasar-error
                     :code "security.forbidden"
                     :message (format nil "Workspace ~A is not authorized." workspace)))
            (setf (ws-connection-workspace conn) workspace)
            (record-audit server "command"
                          :principal (ws-connection-principal conn)
                          :workspace workspace
                          :command (safe-decode-command message)
                          :outcome "accepted"))
          (if (string= (safe-decode-command message) "system.capabilities")
              (ignore-errors
                (wsd:send-text
                 connection
                 (quasar.protocol:encode-result
                  (safe-decode-id message)
                  (apply #'quasar.protocol:json-array
                         (sort (copy-list (ws-connection-capabilities conn))
                               #'string<)))))
              (quasar.control-plane:submit-command
               plane
               message
               (lambda (response)
                 (ignore-errors
                   (wsd:send-text connection response))))))
      (quasar.protocol:quasar-error (condition)
        (record-audit server "command"
                      :principal (ws-connection-principal conn)
                      :workspace (ws-connection-workspace conn)
                      :command (safe-decode-command message)
                      :outcome (quasar.protocol:quasar-error-code condition))
        (ignore-errors
          (wsd:send-text connection
                         (quasar.protocol:quasar-error-to-envelope
                          (safe-decode-id message)
                          condition))))
      (error ()
        (ignore-errors
          (wsd:send-text connection
                         (protocol-error-envelope
                          (safe-decode-id message)
                          "protocol.invalid-envelope")))))))

(defun deliver-event (server encoded)
  "Deliver an event only to connections subscribed to the event's workspace.
  Parses the workspace from the encoded event envelope."
  (let ((event-workspace
          (handler-case
              (quasar.protocol:json-value (jsown:parse encoded) "workspace")
            (error () "default"))))
    (loop for conn in (bt:with-lock-held ((websocket-server-lock server))
                        (loop for value being the hash-values
                                of (websocket-server-connections server)
                              collect value))
          when (string= (ws-connection-workspace conn) event-workspace)
          do (ignore-errors
               (wsd:send-text (ws-connection-ws conn) encoded)))))

(defun random-session-id ()
  (format nil "session-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defun request-header (env name)
  (let ((headers (getf env :headers)))
    (cond
      ((hash-table-p headers) (gethash (string-downcase name) headers))
      ((listp headers)
       (cdr (assoc name headers :test #'string-equal)))
      (t nil))))

(defun query-parameter (env name)
  (let ((query (or (getf env :query-string) "")))
    (loop for part in (uiop:split-string query :separator '(#\&))
          for equals = (position #\= part)
          when (and equals (string= name (subseq part 0 equals)))
            do (return (subseq part (1+ equals))))))

(defun handshake-session (server env)
  (if (websocket-server-insecure-development-p server)
      (list :principal "insecure-development"
            :workspaces '("*")
            :capabilities (websocket-server-capabilities server))
      (bt:with-lock-held ((websocket-server-lock server))
        (gethash (query-parameter env "session")
                 (websocket-server-sessions server)))))

(defun start-websocket-server (server)
  (unless (websocket-server-started-p server)
    (setf *resource* t)
    (let ((app
            (lambda (env)
              (let* ((origin (request-header env "origin"))
                     (session (handshake-session server env)))
                (cond
                  ((not (origin-allowed-p server origin))
                   (record-audit server "handshake" :outcome "origin-denied")
                   '(403 (:content-type "text/plain") ("Origin denied")))
                  ((null session)
                   (record-audit server "handshake" :outcome "unauthorized")
                   '(401 (:content-type "text/plain") ("Unauthorized")))
                  (t
                   (let* ((ws (wsd:make-server env))
                          (connection-id
                            (format nil "conn-~36R" (random most-positive-fixnum)))
                          (conn (make-instance 'ws-connection
                                               :id connection-id
                                               :ws ws
                                               :session-id (random-session-id)
                                               :principal (getf session :principal)
                                               :authorized-workspaces
                                               (getf session :workspaces)
                                               :capabilities
                                               (getf session :capabilities))))
                     (bt:with-lock-held ((websocket-server-lock server))
                       (setf (gethash connection-id
                                     (websocket-server-connections server))
                             conn))
                     (wsd:on :message ws
                             (lambda (message)
                               (handle-text-message server conn message)))
                     (wsd:on :close ws
                             (lambda (&rest args)
                               (declare (ignore args))
                               (bt:with-lock-held ((websocket-server-lock server))
                                 (remhash connection-id
                                          (websocket-server-connections server)))))
                     (record-audit server "handshake"
                                   :principal (getf session :principal)
                                   :outcome "accepted")
                     (wsd:start-connection ws)
                     #'identity)))))))
        (setf (websocket-server-acceptor server)
              (clack:clackup app
                             :host (websocket-server-host server)
                             :port (websocket-server-port server)
                             :use-default-middlewares nil))
        (setf (websocket-server-started-p server) t)))
  server)

(defun stop-websocket-server (server)
  (when (websocket-server-started-p server)
    (detach-subscriber server)
    (when (websocket-server-acceptor server)
      (ignore-errors
        (clack:stop (websocket-server-acceptor server))))
    (bt:with-lock-held ((websocket-server-lock server))
      (clrhash (websocket-server-connections server)))
    (setf (websocket-server-acceptor server) nil
          (websocket-server-started-p server) nil
          *resource* nil))
  t)

(defun attach-subscriber (server)
  "Subscribe the WebSocket server to control-plane events.
  Events are workspace-scoped: only connections subscribed to the same
  workspace receive the event."
  (unless (websocket-server-subscriber-id server)
    (setf (websocket-server-subscriber-id server)
          (quasar.control-plane:subscribe
           (websocket-server-plane server)
           (lambda (encoded)
             (deliver-event server encoded)))))
  (websocket-server-subscriber-id server))

(defun detach-subscriber (server)
  "Unsubscribe the WebSocket server from control-plane events if subscribed."
  (when (websocket-server-subscriber-id server)
    (quasar.control-plane:unsubscribe
     (websocket-server-plane server)
     (websocket-server-subscriber-id server))
    (setf (websocket-server-subscriber-id server) nil)))
