(in-package #:quasar.app)

(defvar *control-plane* nil)
(defvar *websocket-server* nil)
(defvar *browser-session-token* nil)
(defvar *shutdown-semaphore* nil)

(defun new-session-token ()
  (format nil "~36R~36R~36R" (get-universal-time)
          (random most-positive-fixnum) (random most-positive-fixnum)))

(defun start (&key
                (host "127.0.0.1")
                (port 8080)
                (ws-port 8081)
                (frontend-url "/")
                (insecure-development-p nil)
                (open-browser-p nil))
  (when *control-plane*
    (stop))
  (setf quasar.ui:*frontend-url* frontend-url
        *control-plane* (make-control-plane))
  (start-control-plane *control-plane*)
  (install-starlang-commands *control-plane*)
  (setf *websocket-server*
        (make-websocket-server *control-plane* :host host :port ws-port
                               :insecure-development-p insecure-development-p))
  (setf *browser-session-token* (new-session-token))
  (quasar.ws:register-websocket-session
   *websocket-server* *browser-session-token* "local-user" '("default"))
  (attach-subscriber *websocket-server*)
  (start-websocket-server *websocket-server*)
  (start-ui *control-plane*
            :host host
            :port port
            :session-token *browser-session-token*
            :open-browser-p open-browser-p)
  *control-plane*)

(defun stop ()
  (when *websocket-server*
    (stop-websocket-server *websocket-server*)
    (setf *websocket-server* nil))
  (stop-ui)
  (when *control-plane*
    (stop-control-plane *control-plane*)
    (setf *control-plane* nil))
  (setf *browser-session-token* nil)
  t)

(defun main (&key (insecure-development-p nil) (open-browser-p nil))
  (setf *shutdown-semaphore* (bt:make-semaphore :count 0))
  #+sbcl
  (progn
    (sb-sys:enable-interrupt sb-unix:sigterm
                             (lambda (&rest arguments)
                               (declare (ignore arguments))
                               (bt:signal-semaphore *shutdown-semaphore*)))
    (sb-sys:enable-interrupt sb-unix:sigint
                             (lambda (&rest arguments)
                               (declare (ignore arguments))
                               (bt:signal-semaphore *shutdown-semaphore*))))
  (unwind-protect
       (progn
         (start :insecure-development-p insecure-development-p
                :open-browser-p open-browser-p)
         (bt:wait-on-semaphore *shutdown-semaphore*))
    (stop)
    (setf *shutdown-semaphore* nil)))
