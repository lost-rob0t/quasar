(in-package #:quasar.starlang)

(defun package-function (package-name symbol-name)
  (let* ((package (find-package package-name))
         (symbol (and package (find-symbol symbol-name package))))
    (and symbol (fboundp symbol) (symbol-function symbol))))

(defun starlang-available-p ()
  (not (null (package-function "STAR-LANG.API" "LOAD-STAR-RUNTIME"))))

(defun install-starlang-commands (plane)
  (register-command
   plane
   "starlang.status"
   (lambda (payload envelope)
     (declare (ignore payload envelope))
     (json-object
      (cons "available" (starlang-available-p))
      (cons "implementation" "common-lisp")
      (cons "package" "STAR-LANG.API"))))
  (register-command
   plane
   "starlang.load"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (let ((loader (package-function "STAR-LANG.API" "LOAD-STAR-RUNTIME"))
           (source (json-value payload "source")))
       (unless loader
         (error 'quasar.protocol:quasar-error
                :code "control-plane.unavailable"
                :message "StarLang is not loaded. Load the starlang-prototype system first."))
       (unless (stringp source)
         (error 'quasar.protocol:quasar-error
                :code "protocol.invalid-envelope"
                :message "starlang.load requires a string source."))
       (let ((graph (funcall loader source)))
         (json-object
          (cons "loaded" t)
          (cons "runtimeType" (princ-to-string (type-of graph))))))))
  plane)
