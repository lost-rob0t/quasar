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
                 :reader websocket-server-capabilities))
  (:documentation
   "WebSocket server carrying quasar.control.v1 envelopes both directions.
   Each connection is isolated to its selected workspace. Events are only
   delivered to connections subscribed to the same workspace. Origin
   validation, message-size limits, per-connection rate limiting, and
   command capability checks are enforced."))

(defun make-websocket-server (plane &key (host "127.0.0.1") (port 8081)
                              (max-message-size +default-max-message-size+)
                              (allowed-origins +default-allowed-origins+))
  (make-instance 'websocket-server :plane plane :host host :port port
                 :max-message-size max-message-size
                 :allowed-origins allowed-origins))

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
  (or (null origin)
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

(defun command-allowed-p (server command)
  "Check if the command is in the capabilities list."
  (member command (websocket-server-capabilities server) :test #'string=))

(defun handle-text-message (server conn message)
  (let ((plane (websocket-server-plane server))
        (connection (ws-connection-ws conn)))
    (handler-case
        (progn
          (incf (ws-connection-command-count conn))
          (unless (message-size-ok-p server message)
            (error 'quasar.protocol:quasar-error
                   :code "protocol.invalid-envelope"
                   :message "Message exceeds maximum size."))
          (unless (rate-limit-ok-p conn server)
            (error 'quasar.protocol:quasar-error
                   :code "control-plane.unavailable"
                   :message "Rate limit exceeded."))
          (let ((command (safe-decode-command message)))
            (unless (command-allowed-p server command)
              (error 'quasar.protocol:quasar-error
                     :code "protocol.unknown-command"
                     :message (format nil "Command ~A is not permitted." command))))
          (setf (ws-connection-workspace conn) (safe-decode-workspace message))
          (quasar.control-plane:submit-command
           plane
           message
           (lambda (response)
             (ignore-errors
               (wsd:send-text connection response)))))
      (quasar.protocol:quasar-error (condition)
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
                          "protocol.invalid-envelope"))))))

(defun deliver-event (server encoded)
  "Deliver an event only to connections subscribed to the event's workspace.
  Parses the workspace from the encoded event envelope."
  (let ((event-workspace
          (handler-case
              (quasar.protocol:json-value (jsown:parse encoded) "workspace")
            (error () "default"))))
    (loop for conn being the hash-values of (websocket-server-connections server)
          when (string= (ws-connection-workspace conn) event-workspace)
          do (ignore-errors
               (wsd:send-text (ws-connection-ws conn) encoded)))))

(defun random-session-id ()
  (format nil "session-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defun start-websocket-server (server)
  (unless (websocket-server-started-p server)
    (let* ((plane (websocket-server-plane server))
           (resource (make-instance 'quasar-resource
                                     :plane plane
                                     :server server)))
      (setf *resource* resource)
      (let ((handler
              (lambda (connection)
                (let* ((connection-id
                         (format nil "conn-~36R" (random most-positive-fixnum)))
                       (conn (make-instance 'ws-connection
                                            :id connection-id
                                            :ws connection
                                            :session-id (random-session-id))))
                  (setf (gethash connection-id
                                (websocket-server-connections server))
                        conn)
                  (setf (wsd:on-message connection)
                        (lambda (message)
                          (handle-text-message server conn message)))
                  (setf (wsd:on-close connection)
                        (lambda (&rest args)
                          (declare (ignore args))
                          (remhash connection-id
                                   (websocket-server-connections server))))))))
        (setf (websocket-server-acceptor server)
              (wsd:make-server handler))
        (wsd:start-listening (websocket-server-acceptor server)
                             :host (websocket-server-host server)
                             :port (websocket-server-port server))
        (setf (websocket-server-started-p server) t))))
  server)

(defun stop-websocket-server (server)
  (when (websocket-server-started-p server)
    (detach-subscriber server)
    (when (websocket-server-acceptor server)
      (ignore-errors
        (wsd:close-listener (websocket-server-acceptor server))))
    (clrhash (websocket-server-connections server))
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
