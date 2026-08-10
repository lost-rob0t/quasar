(in-package #:quasar.actors.melissa.lookup)

(defun make-lookup-worker (actor-system name config transport normalizer forwarder)
  (let ((worker nil))
    (setf worker
          (sento.actor-context:actor-of
           actor-system
           :name name
           :receive
           (lambda (message)
             (when (typep message 'melissa-lookup)
               (handler-case
                   (multiple-value-bind (raw-result provenance)
                       (funcall transport
                                config
                                (melissa-lookup-entity message)
                                (melissa-lookup-options message))
                     (sento.actor:tell
                      normalizer
                      (make-melissa-normalize
                       :request-id (melissa-lookup-request-id message)
                       :requestor (melissa-lookup-requestor message)
                       :original-entity (melissa-lookup-entity message)
                       :raw-result raw-result
                       :provenance provenance)))
                 (quasar.actors.melissa.transport::melissa-transport-error (condition)
                   (sento.actor:tell
                    forwarder
                    (make-melissa-error
                     :request-id (melissa-lookup-request-id message)
                     :requestor (melissa-lookup-requestor message)
                     :stage :lookup
                     :condition (princ-to-string condition)
                     :retryable-p (retryable-transport-condition-p condition))))
                 (error (condition)
                   (sento.actor:tell
                    forwarder
                    (make-melissa-error
                     :request-id (melissa-lookup-request-id message)
                     :requestor (melissa-lookup-requestor message)
                     :stage :lookup
                     :condition (princ-to-string condition)
                     :retryable-p t))
                   (sento.actor:tell worker :stop)
                   (error condition)))))))
    worker))
