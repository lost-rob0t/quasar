(in-package #:quasar.ui)

(defparameter *frontend-url* "/frontend/")
(defvar *last-session* nil)
(defvar *sessions* (make-hash-table :test #'equal))

(defclass ui-session ()
  ((id :initarg :id :reader session-id)
   (body :initarg :body :reader session-body)
   (plane :initarg :plane :reader session-plane))
  (:documentation
   "A CLOG browser session. CLOG owns hosting and serving the built frontend
   and provides session identity. Typed command traffic crosses the separate
   WebSocket server (quasar.ws); CLOG is no longer the command transport."))

(defun random-session-id ()
  (format nil "session-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defun frontend-asset-path ()
  "Return the directory containing the built frontend assets.
In development the Vite dev server serves the UI directly; in production CLOG
serves the contents of frontend/dist/ from the repository root."
  (merge-pathnames "frontend/dist/"
                   (asdf:system-source-directory :quasar-web)))

(defun install-static-routes (body)
  "Register CLOG static file routes for the built frontend assets so a single
production process can serve the UI without a separate web server."
  (declare (ignore body))
  (let ((asset-root (frontend-asset-path)))
    (when (probe-file asset-root)
      (setf (clog:get-on-path "/frontend/")
            (lambda (path)
              (let ((full (merge-pathnames
                           (string-left-trim "/" path)
                           asset-root)))
                (when (probe-file full)
                  (clog:serve-file full))))))))

(defun install-host (body plane)
  (let ((session
          (make-instance 'ui-session
                         :id (random-session-id)
                         :body body
                         :plane plane)))
    (setf (gethash (session-id session) *sessions*) session
          *last-session* session)
    session))

(defun start-ui (plane &key (host "127.0.0.1") (port 8080) (open-browser-p t))
  (declare (ignore plane))
  (clog:initialize (lambda (body)
                     (install-static-routes body)
                     (install-host body plane))
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
  (declare (ignore name payload))
  "Event broadcast is owned by the WebSocket server. This stub remains for
backward compatibility while CLOG keeps its host role."
  t)
