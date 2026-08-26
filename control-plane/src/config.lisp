(defpackage #:quasar.config
  (:use #:cl)
  (:export
   #:*autodig-persistence-backend*
   #:*autodig-filesystem-path*
   #:default-init-path
   #:default-autodig-filesystem-path
   #:ensure-init-file
   #:load-init-file
   #:resolve-init-path
   #:safe-load-init
   #:reset-config))

(in-package #:quasar.config)

(defparameter *autodig-persistence-backend* :tek9)
(defparameter *autodig-filesystem-path* nil)

(defun default-config-home ()
  (let ((xdg (uiop:getenv "XDG_CONFIG_HOME")))
    (if (and xdg (plusp (length xdg)))
        (uiop:ensure-directory-pathname xdg)
        (merge-pathnames #P".config/" (user-homedir-pathname)))))

(defun default-data-home ()
  (let ((xdg (uiop:getenv "XDG_DATA_HOME")))
    (if (and xdg (plusp (length xdg)))
        (uiop:ensure-directory-pathname xdg)
        (merge-pathnames #P".local/share/" (user-homedir-pathname)))))

(defun default-init-path ()
  (merge-pathnames #P"quasar/init.lisp" (default-config-home)))

(defun default-autodig-filesystem-path ()
  (merge-pathnames #P"quasar/autodig/" (default-data-home)))

(defun reset-config ()
  (setf *autodig-persistence-backend* :tek9
        *autodig-filesystem-path* nil)
  t)

(defun repository-example-init-path ()
  (let* ((source (asdf:system-source-directory :quasar-control))
         (root (uiop:pathname-parent-directory-pathname source)))
    (merge-pathnames #P"example_configs/init.lisp" root)))

(defun write-minimal-init (path)
  (with-open-file (stream path
                          :direction :output
                          :if-does-not-exist :create
                          :if-exists :supersede)
    (format stream ";; Quasar init file~%")
    (format stream "(in-package #:quasar.config)~%")
    (format stream "(setf *autodig-persistence-backend* :tek9)~%")))

(defun ensure-init-file (path)
  (let ((path (uiop:ensure-pathname path :want-file t)))
    (unless (probe-file path)
      (ensure-directories-exist path)
      (let ((example (repository-example-init-path)))
        (if (probe-file example)
            (uiop:copy-file example path)
            (write-minimal-init path))))
    path))

(defun load-init-file (path)
  "Load PATH as trusted executable Common Lisp configuration.
Errors are intentionally propagated so production startup fails closed."
  (let ((path (uiop:ensure-pathname path :want-file t)))
    (unless (probe-file path)
      (error "Quasar init file does not exist: ~A" path))
    (load path :verbose nil :print nil)
    t))

(defun safe-load-init (path)
  (let ((path (ensure-init-file path)))
    (load-init-file path)))

(defun argument-value (arguments names)
  (loop for tail on arguments
        for argument = (first tail)
        when (member argument names :test #'string=)
          do (let ((value (second tail)))
               (unless (and value (plusp (length value)))
                 (error "~A requires a path argument." argument))
               (return value))))

(defun resolve-init-path (&optional (arguments (uiop:command-line-arguments)))
  (let ((argument (argument-value arguments '("--init" "-i")))
        (environment (uiop:getenv "QUASAR_INIT_FILE")))
    (uiop:ensure-pathname
     (or argument
         (and environment (plusp (length environment)) environment)
         (default-init-path))
     :want-file t)))
