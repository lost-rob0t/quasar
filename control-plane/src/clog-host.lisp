(in-package #:quasar.ui)

(defparameter *frontend-url* "/")
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

(defun install-host (body plane)
  (let ((session
          (make-instance 'ui-session
                         :id (random-session-id)
                         :body body
                         :plane plane)))
    (setf (gethash (session-id session) *sessions*) session
          *last-session* session)
    session))

(defun inject-session-token (html token)
  (let ((marker (search "</head>" html :test #'char-equal))
        (tag (format nil "<meta name=\"quasar-session-token\" content=\"~A\">" token)))
    (if marker
        (concatenate 'string (subseq html 0 marker) tag (subseq html marker))
        html)))

(defun start-ui (plane &key (host "127.0.0.1") (port 8080) (open-browser-p t)
                             session-token)
  (let ((asset-root (frontend-asset-path)))
    (clog:initialize
     (lambda (body)
       (install-host body plane))
     :host host
     :port port
     :boot-file "/index.html"
     :boot-function (when session-token
                      (lambda (url html)
                        (declare (ignore url))
                        (inject-session-token html session-token)))
     :extended-routing t
     :static-boot-html "<!doctype html><title>Quasar</title><p>Frontend build not present; use the Vite development server.</p>"
     :static-root (when (probe-file asset-root)
                    (namestring asset-root)))
    (dolist (route '("/graph" "/documents" "/datasets" "/import" "/stats"
                     "/settings" "/agents"))
      (clog:set-on-new-window
       (lambda (body) (install-host body plane))
       :path route
       :boot-file "/index.html")))
  (when open-browser-p
    (clog:open-browser))
  t)

(defun stop-ui ()
  (when (clog:is-running-p)
    (clog:shutdown))
  (clrhash *sessions*)
  (setf *last-session* nil)
  t)
