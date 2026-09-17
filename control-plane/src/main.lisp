(in-package #:quasar.app)

(defvar *control-plane* nil)
(defvar *websocket-server* nil)
(defvar *workspace-store* nil)
(defvar *workspace-store-owned-p* nil)
(defvar *browser-session-token* nil)
(defvar *shutdown-semaphore* nil)

(defparameter +fbp-browser-capabilities+
  '("fbp.catalog.list"
    "fbp.dsl.validate"
    "fbp.run.start"
    "fbp.run.stop"
    "fbp.run.status"
    "fbp.deployment.plan"
    "fbp.profile.plan")
  "Non-mutating and sandboxed-run commands available to the local browser.")

(defparameter +fbp-local-operator-capabilities+
  '("fbp.deployment.apply" "fbp.profile.apply")
  "Host-mutating commands granted only to the loopback local operator session.")

(defun packaged-automation-executable ()
  (or (uiop:getenv "QUASAR_FBP_EXECUTABLE")
      (let ((argv0 (uiop:argv0)))
        (when (and argv0 (search "quasar-server" argv0 :test #'char-equal))
          argv0))))

(defun credential-environment-name (reference)
  (let ((suffix (subseq reference (length "credential:"))))
    (format nil "QUASAR_CREDENTIAL_~A"
            (string-upcase
             (substitute #\_ #\-
                         (substitute #\_ #\. suffix))))))

(defun resolve-environment-credential (reference)
  (or (let ((directory (uiop:getenv "CREDENTIALS_DIRECTORY")))
        (when directory
          (let ((path (merge-pathnames
                       (subseq reference (length "credential:"))
                       (uiop:ensure-directory-pathname directory))))
            (when (probe-file path)
              (string-trim '(#\Space #\Tab #\Newline #\Return)
                           (uiop:read-file-string path))))))
      (uiop:getenv (credential-environment-name reference))
      (when (string= reference "credential:starintel-api")
        (uiop:getenv "STARINTEL_API_KEY"))))

(defun comma-separated-environment (name)
  (let ((value (uiop:getenv name)))
    (when value
      (remove-if (lambda (item) (zerop (length item)))
                 (mapcar (lambda (item)
                           (string-trim '(#\Space #\Tab) item))
                         (uiop:split-string value :separator '(#\,)))))))

(defun configure-default-fbp-runtime ()
  (let* ((endpoint (uiop:getenv "STARINTEL_ENDPOINT"))
         (allowed (comma-separated-environment
                   "QUASAR_STARINTEL_ALLOWED_OPERATIONS"))
         (enabled (and endpoint allowed)))
    (if enabled
        (let ((manifest (quasar.fbp.control::manifest-document endpoint)))
          (multiple-value-bind (grants operations)
              (quasar.fbp.control:register-starintel-operation-nodes
               :manifest manifest :allowed-operations allowed)
            (quasar.fbp.control:configure-fbp-runtime
             :services
             (list :starintel-operation
                   (quasar.fbp.control:make-starintel-operation-service
                    :endpoint endpoint
                    :operations operations
                    :allowed-operations allowed
                    :credential-resolver #'resolve-environment-credential
                    :authorization-header
                    (or (uiop:getenv "STARINTEL_AUTH_HEADER") "authorization")
                    :authorization-prefix
                    (or (uiop:getenv "STARINTEL_AUTH_PREFIX") "Bearer ")))
             :grants grants
             :limits '(:packets 100000 :bytes 67108864 :seconds 3600 :trace 1000
                       :concurrency 4)
             :starintel-endpoint endpoint
             :starintel-credential-reference
             (or (uiop:getenv "STARINTEL_CREDENTIAL_REF")
                 "credential:starintel-api")
             :automation-executable (packaged-automation-executable))))
        (quasar.fbp.control:configure-fbp-runtime
         :services nil :grants nil
         :limits '(:packets 100000 :bytes 67108864 :seconds 3600 :trace 1000
                   :concurrency 4)
         :starintel-endpoint endpoint
         :starintel-credential-reference
         (or (uiop:getenv "STARINTEL_CREDENTIAL_REF")
             "credential:starintel-api")
         :automation-executable (packaged-automation-executable)))))

(defun fbp-run-argument ()
  (let ((arguments (uiop:command-line-arguments)))
    (when (and arguments (string= (first arguments) "fbp-run"))
      (let ((position (position "--graph" arguments :test #'string=)))
        (unless (and position (nth (1+ position) arguments))
          (error "Usage: quasar-server fbp-run --graph PATH"))
        (nth (1+ position) arguments)))))

(defun run-fbp-automation (path)
  "Run one installed FBP graph in the packaged Quasar process."
  (configure-default-fbp-runtime)
  (let* ((source (uiop:read-file-string path))
         (network (quasar.fbp:read-network source))
         (runtime (quasar.fbp:make-runtime
                   network
                   :services quasar.fbp.control::*runtime-services*
                   :grants quasar.fbp.control::*runtime-grants*
                   :host-limits quasar.fbp.control::*runtime-limits*)))
    (quasar.fbp:start-runtime runtime :background nil)))

(defun new-session-token ()
  (format nil "~36R~36R~36R" (get-universal-time)
          (random most-positive-fixnum) (random most-positive-fixnum)))

(defun start (&key
                (host "127.0.0.1")
                (port 8080)
                (ws-port 8081)
                (frontend-url "/")
                (insecure-development-p nil)
                (enable-fbp-host-mutations-p
                  (string= (or (uiop:getenv "QUASAR_ENABLE_FBP_HOST_MUTATIONS") "") "1"))
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
  (when (and enable-fbp-host-mutations-p
             (not (member host '("127.0.0.1" "::1" "localhost") :test #'string-equal)))
    (error "FBP host mutations require an explicitly loopback-only Quasar host."))
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
        (quasar.fbp.control:install-fbp-commands *control-plane*)
        (configure-default-fbp-runtime)
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
         *websocket-server* *browser-session-token* "local-user" '("default")
         :capabilities (append quasar.ws::+default-capabilities+
                               +fbp-browser-capabilities+
                               (when enable-fbp-host-mutations-p
                                 +fbp-local-operator-capabilities+))
         :authority-kind (if enable-fbp-host-mutations-p :operator :internal))
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
    (quasar.fbp.control:stop-all-workflows)
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
  (let ((graph (fbp-run-argument)))
    (when graph
      (return-from main (run-fbp-automation graph))))
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
