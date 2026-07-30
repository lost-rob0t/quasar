(in-package #:quasar.app)

(defvar *control-plane* nil)

(defun start (&key
                (host "127.0.0.1")
                (port 8080)
                (frontend-url "/frontend/")
                (open-browser-p t))
  (when *control-plane*
    (stop))
  (setf quasar.ui:*frontend-url* frontend-url
        *control-plane* (make-control-plane))
  (start-control-plane *control-plane*)
  (install-starlang-commands *control-plane*)
  (start-ui *control-plane*
            :host host
            :port port
            :open-browser-p open-browser-p)
  *control-plane*)

(defun stop ()
  (stop-ui)
  (when *control-plane*
    (stop-control-plane *control-plane*)
    (setf *control-plane* nil))
  t)

(defun main ()
  (start)
  (loop (sleep 3600)))
