(in-package #:quasar.app)

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
