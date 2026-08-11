(in-package #:quasar.actors.melissa.transport)

(defmacro when-let (bindings &body body)
  (destructuring-bind ((name form)) bindings
    `(let ((,name ,form))
       (when ,name
         ,@body))))
