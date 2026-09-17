(in-package #:quasar.fbp)

(defun context-service (context key)
  (getf (getf context :services) key))

(defun required-service (context key)
  (or (context-service context key)
      (error 'sandbox-denied :code "fbp.service-unavailable"
             :message (format nil "Runtime service ~A is unavailable or not allowed." key))))

(defun single-input (inputs &optional (name "in"))
  (cdr (assoc name inputs :test #'string=)))

(defun register-builtins ()
  (define-node core/identity
      (:label "Identity" :category "Core"
       :inputs ((in :schema (:type "any")))
       :outputs ((out :schema (:type "any"))))
      (inputs context)
    (declare (ignore context))
    (list (cons "out" (list (single-input inputs)))))

  (define-node core/split
      (:label "Split" :category "Core"
       :inputs ((in :schema (:type "array")))
       :outputs ((out :schema (:type "any") :array t)))
      (inputs context)
    (declare (ignore context))
    (list (cons "out" (copy-list (single-input inputs)))))

  (define-node core/merge
      (:label "Merge" :category "Core"
       :inputs ((in :schema (:type "any")))
       :outputs ((out :schema (:type "any"))))
      (inputs context)
    (declare (ignore context))
    (list (cons "out" (list (single-input inputs)))))

  (define-node object/build
      (:label "Build StarIntel object" :category "Objects"
       :inputs ((trigger :schema (:type "any")))
       :outputs ((object :schema (:type "object"))))
      (inputs context)
    (declare (ignore inputs))
    (list (cons "object" (list (copy-tree (getf context :config))))))

  (define-node language/lisp
      (:label "Trusted Lisp component" :category "Languages"
       :inputs ((in :schema (:type "any")))
       :outputs ((out :schema (:type "any")))
       :capabilities (:raw-lisp))
      (inputs context)
    (list (cons "out"
                (list (funcall (required-service context :trusted-lisp-component)
                               (getf (getf context :config) :component)
                               (single-input inputs))))))

  (define-node language/star
      (:label "Star Language" :category "Languages"
       :inputs ((in :schema (:type "any")))
       :outputs ((out :schema (:type "any")))
       :capabilities (:star-language))
      (inputs context)
    (list (cons "out"
                (list (funcall (required-service context :star-language)
                               (getf (getf context :config) :program)
                               (single-input inputs))))))

  (define-node process/exec
      (:label "Sandboxed process" :category "Languages"
       :inputs ((stdin :schema (:type "string")))
       :outputs ((stdout :schema (:type "string"))
                 (status :schema (:type "integer")))
       :capabilities (:process))
      (inputs context)
    (multiple-value-bind (stdout status)
        (funcall (required-service context :sandboxed-process)
                 (getf (getf context :config) :argv)
                 (single-input inputs "stdin")
                 (getf context :config))
      (list (cons "stdout" (list stdout))
            (cons "status" (list status)))))
  t)

(register-builtins)
