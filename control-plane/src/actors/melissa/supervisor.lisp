(in-package #:quasar.actors.melissa.supervisor)

(defun worker-name (index)
  (format nil "melissa-lookup-~D-~36R" index (random most-positive-fixnum)))

(defun supervisor-actor-name ()
  (format nil "melissa-supervisor-~36R" (random most-positive-fixnum)))

(defun build-worker-router (workers)
  (sento.router:make-router
   :strategy :round-robin
   :routees workers))

(defun start-melissa-subsystem (actor-system
                                &key
                                  (config (make-melissa-config))
                                  (worker-count +default-melissa-worker-count+)
                                  (transport #'perform-melissa-lookup))
  (unless (and (integerp worker-count) (plusp worker-count))
    (error "Melissa worker count must be a positive integer."))
  (let* ((subsystem
           (make-instance 'melissa-subsystem
                          :actor-system actor-system
                          :config config
                          :transport transport
                          :worker-count worker-count))
         (forwarder (make-forwarder-actor actor-system))
         (normalizer (make-normalizer-actor actor-system forwarder)))
    (setf (melissa-subsystem-forwarder subsystem) forwarder
          (melissa-subsystem-normalizer subsystem) normalizer)
    (labels ((spawn-worker (index)
               (let ((worker
                       (make-lookup-worker
                        actor-system
                        (worker-name index)
                        config
                        transport
                        normalizer
                        forwarder)))
                 (sento.actor:watch worker (melissa-subsystem-supervisor subsystem))
                 worker))
             (rebuild-router ()
               (let ((router (build-worker-router (melissa-subsystem-workers subsystem))))
                 (setf (melissa-subsystem-worker-router subsystem) router)
                 (when (melissa-subsystem-request-router subsystem)
                   (sento.actor:tell
                    (melissa-subsystem-request-router subsystem)
                    (make-melissa-router-update :router router)))
                 router))
             (replace-worker (stopped-worker)
               (unless (melissa-subsystem-stopped-p subsystem)
                 (let ((index (position stopped-worker
                                        (melissa-subsystem-workers subsystem)
                                        :test #'eq)))
                   (when index
                     (let ((replacement (spawn-worker index)))
                       (setf (nth index (melissa-subsystem-workers subsystem)) replacement)
                       (rebuild-router)))))))
      (setf (melissa-subsystem-supervisor subsystem)
            (sento.actor-context:actor-of
             actor-system
             :name (supervisor-actor-name)
             :receive
             (lambda (message)
               (when (and (consp message) (eq (car message) :stopped))
                 (replace-worker (cdr message))))))
      (setf (melissa-subsystem-workers subsystem)
            (loop for index below worker-count collect (spawn-worker index)))
      (let ((router (rebuild-router)))
        (setf (melissa-subsystem-request-router subsystem)
              (make-request-router actor-system router forwarder)))
      subsystem)))

(defun stop-actor (actor)
  (when actor
    (ignore-errors (sento.actor:tell actor :stop))))

(defun stop-melissa-subsystem (subsystem)
  (unless (melissa-subsystem-stopped-p subsystem)
    (setf (melissa-subsystem-stopped-p subsystem) t)
    (stop-actor (melissa-subsystem-supervisor subsystem))
    (dolist (worker (melissa-subsystem-workers subsystem))
      (stop-actor worker))
    (stop-actor (melissa-subsystem-request-router subsystem))
    (stop-actor (melissa-subsystem-normalizer subsystem))
    (stop-actor (melissa-subsystem-forwarder subsystem))
    (stop-actor (melissa-subsystem-http-bridge subsystem)))
  t)

(defun actor-path-string (actor)
  (handler-case
      (princ-to-string (sento.actor:path actor))
    (error () "unavailable")))

(defun melissa-subsystem-status (subsystem)
  (json-object
   (cons "started" (not (melissa-subsystem-stopped-p subsystem)))
   (cons "configured"
         (and (stringp (melissa-config-license-key
                        (melissa-subsystem-config subsystem)))
              (plusp (length (melissa-config-license-key
                              (melissa-subsystem-config subsystem))))))
   (cons "worker_count" (length (melissa-subsystem-workers subsystem)))
   (cons "router" (actor-path-string (melissa-subsystem-request-router subsystem)))
   (cons "workers"
         (apply #'json-array
                (mapcar #'actor-path-string
                        (melissa-subsystem-workers subsystem))))))
