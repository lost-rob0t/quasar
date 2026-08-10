(in-package #:quasar.actors.melissa.forwarder)

(defun make-forwarder-actor (actor-system)
  (sento.actor-context:actor-of
   actor-system
   :name "melissa-requestor-forwarder"
   :receive
   (lambda (message)
     (cond
       ((typep message 'melissa-forward)
        (sento.actor:tell
         (melissa-forward-requestor message)
         (make-melissa-completed
          :request-id (melissa-forward-request-id message)
          :entity (melissa-forward-entity message))))
       ((typep message 'melissa-error)
        (sento.actor:tell
         (melissa-error-requestor message)
         message))))))
