(in-package #:quasar.app)

(defvar *control-plane* nil)
(defvar *websocket-server* nil)
(defvar *workspace-store* nil)
(defvar *workspace-store-owned-p* nil)
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
                (open-browser-p nil)
                workspace-store
                storage-path
                (melissa-worker-count 3)
                (melissa-license-key (uiop:getenv "QUASAR_MELISSA_LICENSE_KEY"))
                melissa-config
                melissa-transport)
  "Start Quasar with Tek9 as the production workspace store.

WORKSPACE-STORE may inject an already-created store for deployments or tests.
Otherwise Quasar owns one full-durability Tek9 store for the process lifetime.
STORAGE-PATH overrides the normal XDG data path when Quasar creates that store."
  (when (or *control-plane* *workspace-store*)
    (stop))
  (setf quasar.ui:*frontend-url* frontend-url
        *workspace-store-owned-p* (null workspace-store)
        *workspace-store*
        (or workspace-store
            (if storage-path
                (make-tek9-store :path storage-path)
                (make-tek9-store)))
        *control-plane* (make-control-plane :store *workspace-store*))
  (handler-case
      (progn
        (start-control-plane *control-plane*)
        (install-starlang-commands *control-plane*)
        (quasar.actors.melissa.bridge:start-melissa-integration
         *control-plane*
         :config (or melissa-config
                     (quasar.actors.melissa:make-melissa-config
                      :license-key melissa-license-key))
         :worker-count melissa-worker-count
         :transport melissa-transport)
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
    (error (condition)
      (stop)
      (error condition))))

(defun stop ()
  (when *websocket-server*
    (stop-websocket-server *websocket-server*)
    (setf *websocket-server* nil))
  (stop-ui)
  (when *control-plane*
    (quasar.actors.melissa.bridge:stop-melissa-integration *control-plane*)
    (stop-control-plane *control-plane*)
    (setf *control-plane* nil))
  (when *workspace-store*
    (when *workspace-store-owned-p*
      (close-store *workspace-store*))
    (setf *workspace-store* nil
          *workspace-store-owned-p* nil))
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
