(in-package #:quasar.actors.melissa.router)

(defun valid-request-id-p (value)
  (and (stringp value)
       (plusp (length (string-trim '(#\Space #\Tab #\Newline #\Return) value)))))

(defun request-error (message text)
  (make-melissa-error
   :request-id (or (melissa-request-request-id message) "invalid-request")
   :requestor (melissa-request-requestor message)
   :stage :route
   :condition text
   :retryable-p nil))

(defun valid-entity-p (entity)
  (and (typep entity 'canonical-entity)
       (member (canonical-entity-kind entity) '("person" "target") :test #'string=)))

(defun request-router-actor-name ()
  (format nil "melissa-request-router-~36R" (random most-positive-fixnum)))

(defun make-request-router (actor-system initial-worker-router forwarder)
  (let ((worker-router initial-worker-router))
    (sento.actor-context:actor-of
     actor-system
     :name (request-router-actor-name)
     :receive
     (lambda (message)
       (cond
         ((typep message 'melissa-router-update)
          (setf worker-router (melissa-router-update-router message)))
         ((typep message 'melissa-request)
          (cond
            ((null (melissa-request-requestor message))
             nil)
            ((not (valid-request-id-p (melissa-request-request-id message)))
             (sento.actor:tell forwarder
                               (request-error message "Melissa request-id must be a non-empty string.")))
            ((not (valid-entity-p (melissa-request-entity message)))
             (sento.actor:tell forwarder
                               (request-error message "Melissa request entity must be a canonical person or target.")))
            ((null worker-router)
             (sento.actor:tell
              forwarder
              (make-melissa-error
               :request-id (melissa-request-request-id message)
               :requestor (melissa-request-requestor message)
               :stage :route
               :condition "Melissa lookup worker pool is unavailable."
               :retryable-p t)))
            (t
             (sento.actor:tell
              worker-router
              (make-melissa-lookup
               :request-id (melissa-request-request-id message)
               :requestor (melissa-request-requestor message)
               :entity (melissa-request-entity message)
               :options (melissa-request-options message)))))))))))
