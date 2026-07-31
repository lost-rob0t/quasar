(in-package #:quasar.app)

(defvar *control-plane* nil)
(defvar *websocket-server* nil)

(defun start (&key
                (host "127.0.0.1")
                (port 8080)
                (ws-port 8081)
                (frontend-url "/")
                (open-browser-p nil))
  (when *control-plane*
    (stop))
  (setf quasar.ui:*frontend-url* frontend-url
        *control-plane* (make-control-plane))
  (start-control-plane *control-plane*)
  (install-starlang-commands *control-plane*)
  (setf *websocket-server*
        (make-websocket-server *control-plane* :host host :port ws-port))
  (attach-subscriber *websocket-server*)
  (start-websocket-server *websocket-server*)
  (start-ui *control-plane*
            :host host
            :port port
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
  t)

(defun main ()
  (start)
  (loop (sleep 3600)))
