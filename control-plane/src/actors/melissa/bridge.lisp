(in-package #:quasar.actors.melissa.bridge)

(defvar *melissa-subsystems* (make-hash-table :test #'eq))

(defun melissa-subsystem-for (plane)
  (gethash plane *melissa-subsystems*))

(defun bridge-reply-actor-name ()
  (format nil "melissa-http-reply-~36R" (random most-positive-fixnum)))

(defun make-http-reply-actor (subsystem bridge request)
  (let ((reply-actor nil)
        (finished-p nil))
    (labels ((finish ()
               (unless finished-p
                 (setf finished-p t)
                 (sento.actor:tell bridge (cons :finished reply-actor))
                 (sento.actor:tell reply-actor :stop)))
             (fail-stopped ()
               (unless finished-p
                 (funcall
                  (melissa-http-request-on-error request)
                  (quasar.actors.melissa:make-melissa-error
                   :request-id (melissa-http-request-request-id request)
                   :requestor reply-actor
                   :stage :bridge
                   :condition "Melissa integration stopped before the request completed."
                   :retryable-p t))
                 (finish))))
      (setf reply-actor
            (sento.actor-context:actor-of
             (quasar.actors.melissa:melissa-subsystem-actor-system subsystem)
             :name (bridge-reply-actor-name)
             :receive
             (lambda (message)
               (cond
                 ((typep message 'melissa-completed)
                  (unless finished-p
                    (funcall (melissa-http-request-on-success request)
                             (melissa-completed-entity message))
                    (finish))
                  t)
                 ((typep message 'melissa-error)
                  (unless finished-p
                    (funcall (melissa-http-request-on-error request) message)
                    (finish))
                  t)
                 ((eq message :shutdown)
                  (fail-stopped)
                  t)))))
      reply-actor)))

(defun make-http-bridge-actor (subsystem)
  (let ((pending (make-hash-table :test #'eq))
        (bridge nil))
    (setf bridge
          (sento.actor-context:actor-of
           (quasar.actors.melissa:melissa-subsystem-actor-system subsystem)
           :name "melissa-http-bridge"
           :receive
           (lambda (message)
             (cond
               ((typep message 'melissa-http-request)
                (let ((reply-actor (make-http-reply-actor subsystem bridge message)))
                  (setf (gethash reply-actor pending) t)
                  (sento.actor:tell
                   (quasar.actors.melissa:melissa-subsystem-request-router subsystem)
                   (make-melissa-request
                    :request-id (melissa-http-request-request-id message)
                    :requestor reply-actor
                    :entity (melissa-http-request-entity message)
                    :options (melissa-http-request-options message)))
                  t))
               ((and (consp message) (eq (car message) :finished))
                (remhash (cdr message) pending)
                t)
               ((eq message :shutdown)
                (let ((actors
                        (loop for actor being the hash-keys of pending
                              collect actor)))
                  (dolist (actor actors)
                    (ignore-errors
                      (sento.actor:ask-s actor :shutdown :time-out 1)))
                  (clrhash pending)
                  t))))))
    bridge))

(defun error-details (condition)
  (json-object
   (cons "stage" (string-downcase (symbol-name (melissa-error-stage condition))))
   (cons "retryable" (if (melissa-error-retryable-p condition) t nil))))

(defun start-melissa-integration (plane
                                  &key
                                    (config (make-melissa-config))
                                    (worker-count +default-melissa-worker-count+)
                                    transport)
  (when (melissa-subsystem-for plane)
    (stop-melissa-integration plane))
  (let* ((subsystem
           (if transport
               (start-melissa-subsystem
                (control-plane-actor-system plane)
                :config config
                :worker-count worker-count
                :transport transport)
               (start-melissa-subsystem
                (control-plane-actor-system plane)
                :config config
                :worker-count worker-count)))
         (bridge (make-http-bridge-actor subsystem)))
    (setf (melissa-subsystem-http-bridge subsystem) bridge
          (gethash plane *melissa-subsystems*) subsystem)
    (register-async-command
     plane
     "melissa.request"
     (lambda (request-id payload envelope reply)
       (declare (ignore envelope))
       (let ((entity-object (json-value payload "entity" nil))
             (options-object (json-value payload "options" (json-object))))
         (unless entity-object
           (error "melissa.request requires an entity object."))
         (sento.actor:tell
          bridge
          (make-melissa-http-request
           :request-id request-id
           :entity (canonical-entity-from-json entity-object)
           :options (json-options-to-plist options-object)
           :on-success
           (lambda (entity)
             (funcall reply
                      (encode-result request-id
                                     (canonical-entity-to-json entity))))
           :on-error
           (lambda (condition)
             (funcall reply
                      (encode-error request-id
                                    "melissa-failed"
                                    (melissa-error-condition condition)
                                    (error-details condition)))))))))
    (register-command
     plane
     "melissa.status"
     (lambda (payload envelope)
       (declare (ignore payload envelope))
       (melissa-subsystem-status subsystem)))
    subsystem))

(defun stop-melissa-integration (plane)
  (let ((subsystem (melissa-subsystem-for plane)))
    (when subsystem
      (let ((bridge (melissa-subsystem-http-bridge subsystem)))
        (when bridge
          (ignore-errors
            (sento.actor:ask-s bridge :shutdown :time-out 2))))
      (unregister-command plane "melissa.request")
      (unregister-command plane "melissa.status")
      (stop-melissa-subsystem subsystem)
      (remhash plane *melissa-subsystems*)))
  t)
