(in-package #:quasar.ui)

(defparameter *frontend-url* "/frontend/")
(defvar *last-session* nil)
(defvar *sessions* (make-hash-table :test #'equal))

(defclass ui-session ()
  ((id :initarg :id :reader session-id)
   (body :initarg :body :reader session-body)
   (bridge :initarg :bridge :reader session-bridge)
   (frame :initarg :frame :reader session-frame)
   (plane :initarg :plane :reader session-plane)))

(defun random-session-id ()
  (format nil "session-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defun static-file (relative-path)
  (uiop:read-file-string
   (merge-pathnames relative-path
                    (asdf:system-source-directory "quasar"))))

(defun emit-to-session (session encoded)
  (clog:js-execute
   (session-body session)
   (format nil
           "window.QuasarControlPlaneHost.deliver(~A);"
           (jsown:to-json encoded))))

(defun handle-command (session bridge)
  (let ((encoded (clog:attribute bridge
                                 "data-envelope"
                                 :default-answer "")))
    (submit-command
     (session-plane session)
     encoded
     (lambda (response)
       (emit-to-session session response)))))

(defun install-host (body plane)
  (let* ((root (clog:create-div body :html-id "quasar-host"))
         (frame (clog:create-element root :iframe :html-id "quasar-frontend"))
         (bridge (clog:create-element body
                                      :button
                                      :content ""
                                      :html-id "quasar-command-bridge"))
         (session
           (make-instance 'ui-session
                          :id (random-session-id)
                          :body body
                          :bridge bridge
                          :frame frame
                          :plane plane)))
    (setf (clog:attribute frame "src") *frontend-url*
          (clog:attribute frame "title") "Quasar"
          (clog:attribute frame "style")
          "border:0;width:100vw;height:100vh;display:block")
    (setf (clog:hiddenp bridge) t)
    (clog:set-on-click bridge
                       (lambda (object)
                         (handle-command session object)))
    (setf (gethash (session-id session) *sessions*) session
          *last-session* session)
    (clog:js-execute body (static-file "static/quasar-control-plane.js"))
    session))

(defun start-ui (plane &key (host "127.0.0.1") (port 8080) (open-browser-p t))
  (clog:initialize (lambda (body) (install-host body plane))
                   :host host
                   :port port)
  (when open-browser-p
    (clog:open-browser))
  t)

(defun stop-ui ()
  (when (clog:is-running-p)
    (clog:shutdown))
  (clrhash *sessions*)
  (setf *last-session* nil)
  t)

(defun broadcast-event (name payload)
  (let ((encoded (encode-event name payload)))
    (loop for session being the hash-values of *sessions*
          do (emit-to-session session encoded)))
  t)
