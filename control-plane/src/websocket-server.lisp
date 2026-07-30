(in-package #:quasar.ws)

(defvar *server* nil)

(defclass websocket-server ()
  ((host :initarg :host :initform "127.0.0.1" :reader websocket-server-host)
   (port :initarg :port :initform 8081 :reader websocket-server-port)
   (plane :initarg :plane :reader websocket-server-plane)
   (acceptor :initform nil :accessor websocket-server-acceptor)
   (connections :initform (make-hash-table :test #'equal)
                :reader websocket-server-connections)
   (started-p :initform nil :accessor websocket-server-started-p))
  (:documentation
   "WebSocket server carrying quasar.control.v1 envelopes both directions.
   CLOG keeps its own host role; this endpoint is the typed command stream
   between the React frontend and the control-plane actor."))

(defun make-websocket-server (plane &key (host "127.0.0.1") (port 8081))
  (make-instance 'websocket-server :plane plane :host host :port port))

(defclass quasar-resource ()
  ((plane :initarg :plane :reader resource-plane)
   (server :initarg :server :reader resource-server))
  (:documentation "Hunchentoot resource for the Quasar control-plane WS."))

(defvar *resource* nil)

(defun handle-text-message (server connection message)
  (let ((plane (websocket-server-plane server)))
    (quasar.control-plane:submit-command
     plane
     message
     (lambda (response)
       (ignore-errors
         (wsd:send-text connection response))))))

(defun deliver-event (server encoded)
  (loop for connection being the hash-values of (websocket-server-connections server)
        do (ignore-errors
             (wsd:send-text connection encoded))))

(defun start-websocket-server (server)
  (unless (websocket-server-started-p server)
    (let* ((plane (websocket-server-plane server))
           (resource (make-instance 'quasar-resource
                                     :plane plane
                                     :server server)))
      (setf *resource* resource)
      (let ((handler
              (lambda (connection)
                (let ((connection-id
                        (format nil "conn-~36R" (random most-positive-fixnum))))
                  (setf (gethash connection-id
                                (websocket-server-connections server))
                        connection)
                  (setf (wsd:on-message connection)
                        (lambda (message)
                          (handle-text-message server connection message)))
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
    (when (websocket-server-acceptor server)
      (ignore-errors
        (wsd:close-listener (websocket-server-acceptor server))))
    (clrhash (websocket-server-connections server))
    (setf (websocket-server-acceptor server) nil
          (websocket-server-started-p server) nil
          *resource* nil))
  t)

(defun attach-subscriber (server)
  (quasar.control-plane:subscribe
   (websocket-server-plane server)
   (lambda (encoded)
     (deliver-event server encoded))))
