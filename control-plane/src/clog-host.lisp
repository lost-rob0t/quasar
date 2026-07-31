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

(defun parent-directory (directory)
  "Return the parent of an absolute directory pathname."
  (make-pathname :directory (butlast (pathname-directory directory))))

(defun frontend-asset-path ()
  "Return the directory containing the built frontend assets.
In development the Vite dev server serves the UI directly; in production CLOG
serves the contents of frontend/dist/ from the repository root.

The quasar-web system source lives under systems/, so its source directory is
systems/. Resolve one level up to reach the repository root, then descend into
frontend/dist/. This avoids the systems/frontend/dist/ misresolution that
broke production asset serving."
  (merge-pathnames "frontend/dist/"
                   (parent-directory
                    (asdf:system-source-directory :quasar-web))))

(defun serve-frontend-asset (path asset-root)
  "Serve a single asset from ASSET-ROOT for the request PATH.
The SPA entry point (index.html) is served when the path is empty or points at
the frontend URL root, so client-side routing history works in production."
  (let* ((trimmed (string-left-trim "/" path))
         (full (if (string= trimmed "")
                   (merge-pathnames "index.html" asset-root)
                   (merge-pathnames trimmed asset-root))))
    (when (probe-file full)
      (clog:serve-file full))))

(defun install-static-routes (body)
  "Register CLOG static file routes for the built frontend assets so a single
production process can serve the UI without a separate web server. The route is
registered at *FRONTEND-URL* so CLOG and Vite agree on the same base path."
  (declare (ignore body))
  (let ((asset-root (frontend-asset-path)))
    (when (probe-file asset-root)
      (let ((route (if (string= *frontend-url* "/")
                       "/"
                       (string-right-trim "/" *frontend-url*))))
        (setf (clog:get-on-path route)
              (lambda (path)
                (serve-frontend-asset path asset-root)))))))

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
