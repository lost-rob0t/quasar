(in-package #:quasar.app)

(defun environment-port (name default)
  (let ((value (uiop:getenv name)))
    (if (or (null value) (zerop (length value)))
        default
        (let ((port (parse-integer value :junk-allowed nil)))
          (unless (<= 1 port 65535)
            (error "~A must be a TCP port between 1 and 65535." name))
          port))))

(defun main (&key
               (insecure-development-p nil)
               (open-browser-p nil)
               init-path)
  "Start Quasar after loading its executable Common Lisp init file.

INIT-PATH wins when supplied programmatically. Otherwise --init/-i,
QUASAR_INIT_FILE, then the XDG config path are used. A missing file is created
from example_configs/init.lisp. Invalid configuration aborts startup."
  (quasar.config:safe-load-init
   (or init-path (quasar.config:resolve-init-path)))
  ;; Logging is configured before anything else starts so startup
  ;; itself is observable, and invalid logging configuration fails
  ;; closed exactly like the rest of the init file.
  (quasar.log:apply-config)
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
         (start :host (or (uiop:getenv "QUASAR_HOST") "127.0.0.1")
                 :port (environment-port "QUASAR_HTTP_PORT" 8080)
                 :ws-port (environment-port "QUASAR_WS_PORT" 8081)
                 :storage-path (uiop:getenv "QUASAR_STORAGE_PATH")
                 :insecure-development-p insecure-development-p
                 :open-browser-p open-browser-p)
         (bt:wait-on-semaphore *shutdown-semaphore*))
    (stop)
    (setf *shutdown-semaphore* nil)))
