(in-package #:quasar.tests)

(defun melissa-milliseconds (value)
  (/ value 1000.0))

(defun melissa-wait-until (predicate &key (timeout 3.0))
  (let ((deadline (+ (get-internal-real-time)
                     (* timeout internal-time-units-per-second))))
    (loop
      when (funcall predicate) return t
      when (> (get-internal-real-time) deadline) return nil
      do (sleep 0.01))))

(defun make-melissa-collector (system name)
  (let ((messages nil))
    (sento.actor-context:actor-of
     system
     :name name
     :receive
     (lambda (message)
       (if (eq message :messages)
           (reverse (copy-list messages))
           (push message messages))))))

(defun melissa-collector-messages (collector)
  (sento.actor:ask-s collector :messages :time-out 1))

(defun fake-melissa-transport (config entity options)
  (declare (ignore config))
  (when (getf options :delay-ms)
    (sleep (melissa-milliseconds (getf options :delay-ms))))
  (when (getf options :transport-error)
    (error 'quasar.actors.melissa.transport::melissa-transport-error
           :message "synthetic Melissa transport failure"
           :retryable-p t))
  (when (getf options :crash)
    (error "synthetic lookup worker crash"))
  (let* ((title (quasar.actors.melissa:canonical-entity-title entity))
         (record
           (quasar.protocol:json-object
            (cons "NameFull" title)
            (cons "FirstName" title)
            (cons "EmailAddress"
                  (format nil "~A@example.test"
                          (string-downcase
                           (substitute #\- #\Space title))))
            (cons "Results" "AS01"))))
    (values
     (quasar.protocol:json-object
      (cons "Records" (quasar.protocol:json-array record)))
     (quasar.protocol:json-object
      (cons "service" "personator-search")
      (cons "http_status" 200)))))

(defun all-error-melissa-transport (config entity options)
  (declare (ignore config entity options))
  (values
   (quasar.protocol:json-object
    (cons "Records"
          (quasar.protocol:json-array
           (quasar.protocol:json-object
            (cons "Results" "GE01")
            (cons "NameFull" "Bad A"))
           (quasar.protocol:json-object
            (cons "Results" "SE02")
            (cons "NameFull" "Bad B")))))
   (quasar.protocol:json-object
    (cons "service" "personator-search")
    (cons "http_status" 200))))

(defun melissa-test-entity (kind id title)
  (quasar.actors.melissa:make-canonical-entity
   :kind kind
   :id id
   :dataset "test"
   :title title
   :data (quasar.protocol:json-object (cons "name" title))
   :extensions (quasar.protocol:json-object)))

(defun melissa-completed-message (request-id messages)
  (find request-id
        messages
        :test #'string=
        :key (lambda (message)
               (and (typep message 'quasar.actors.melissa:melissa-completed)
                    (quasar.actors.melissa:melissa-completed-request-id message)))))

(defun melissa-error-message (request-id messages)
  (find request-id
        messages
        :test #'string=
        :key (lambda (message)
               (and (typep message 'quasar.actors.melissa:melissa-error)
                    (quasar.actors.melissa:melissa-error-request-id message)))))

(defun test-melissa-requestor-isolation-and-concurrency ()
  (let* ((system (sento.actor-system:make-actor-system))
         (subsystem
           (quasar.actors.melissa.supervisor:start-melissa-subsystem
            system
            :config (quasar.actors.melissa:make-melissa-config :license-key "test")
            :worker-count 3
            :transport #'fake-melissa-transport))
         (collector-a (make-melissa-collector system "melissa-requestor-a"))
         (collector-b (make-melissa-collector system "melissa-requestor-b")))
    (unwind-protect
         (progn
           (sento.actor:tell
            (quasar.actors.melissa:melissa-subsystem-request-router subsystem)
            (quasar.actors.melissa:make-melissa-request
             :request-id "slow-person"
             :requestor collector-a
             :entity (melissa-test-entity "person" "person:a" "Person A")
             :options '(:delay-ms 200)))
           (sento.actor:tell
            (quasar.actors.melissa:melissa-subsystem-request-router subsystem)
            (quasar.actors.melissa:make-melissa-request
             :request-id "fast-target"
             :requestor collector-b
             :entity (melissa-test-entity "target" "target:b" "Target B")
             :options '(:delay-ms 20)))
           (check
            (melissa-wait-until
             (lambda ()
               (and (melissa-completed-message
                     "slow-person" (melissa-collector-messages collector-a))
                    (melissa-completed-message
                     "fast-target" (melissa-collector-messages collector-b))))))
           (let ((a-messages (melissa-collector-messages collector-a))
                 (b-messages (melissa-collector-messages collector-b)))
             (check (= 1 (length a-messages)))
             (check (= 1 (length b-messages)))
             (check (null (melissa-completed-message "fast-target" a-messages)))
             (check (null (melissa-completed-message "slow-person" b-messages)))))
      (quasar.actors.melissa.supervisor:stop-melissa-subsystem subsystem)
      (sento.actor-context:shutdown system :wait t))))

(defun test-melissa-worker-recovery ()
  (let* ((system (sento.actor-system:make-actor-system))
         (subsystem
           (quasar.actors.melissa.supervisor:start-melissa-subsystem
            system
            :config (quasar.actors.melissa:make-melissa-config :license-key "test")
            :worker-count 2
            :transport #'fake-melissa-transport))
         (requestor (make-melissa-collector system "melissa-crash-requestor"))
         (before (copy-list (quasar.actors.melissa:melissa-subsystem-workers subsystem))))
    (unwind-protect
         (progn
           (sento.actor:tell
            (quasar.actors.melissa:melissa-subsystem-request-router subsystem)
            (quasar.actors.melissa:make-melissa-request
             :request-id "worker-crash"
             :requestor requestor
             :entity (melissa-test-entity "person" "person:crash" "Crash")
             :options '(:crash t)))
           (check
            (melissa-wait-until
             (lambda ()
               (melissa-error-message
                "worker-crash" (melissa-collector-messages requestor)))))
           (check
            (melissa-wait-until
             (lambda ()
               (let ((after (quasar.actors.melissa:melissa-subsystem-workers subsystem)))
                 (and (= (length before) (length after))
                      (not (every #'eq before after)))))))
           (sento.actor:tell
            (quasar.actors.melissa:melissa-subsystem-request-router subsystem)
            (quasar.actors.melissa:make-melissa-request
             :request-id "after-worker-crash"
             :requestor requestor
             :entity (melissa-test-entity "target" "target:recovered" "Recovered")
             :options nil))
           (check
            (melissa-wait-until
             (lambda ()
               (melissa-completed-message
                "after-worker-crash" (melissa-collector-messages requestor))))))
      (quasar.actors.melissa.supervisor:stop-melissa-subsystem subsystem)
      (sento.actor-context:shutdown system :wait t))))

(defun test-melissa-duplicate-external-request-ids ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (result-a nil)
         (result-b nil)
         (failure-a nil)
         (failure-b nil))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (let* ((subsystem
                    (quasar.actors.melissa.bridge:start-melissa-integration
                     plane
                     :config (quasar.actors.melissa:make-melissa-config :license-key "test")
                     :worker-count 2
                     :transport #'fake-melissa-transport))
                  (bridge (quasar.actors.melissa:melissa-subsystem-http-bridge subsystem)))
             (sento.actor:tell
              bridge
              (quasar.actors.melissa:make-melissa-http-request
               :request-id "same-external-id"
               :entity (melissa-test-entity "person" "person:slow" "Slow")
               :options '(:delay-ms 200)
               :on-success (lambda (entity) (setf result-a entity))
               :on-error (lambda (condition) (setf failure-a condition))))
             (sento.actor:tell
              bridge
              (quasar.actors.melissa:make-melissa-http-request
               :request-id "same-external-id"
               :entity (melissa-test-entity "person" "person:fast" "Fast")
               :options '(:delay-ms 20)
               :on-success (lambda (entity) (setf result-b entity))
               :on-error (lambda (condition) (setf failure-b condition))))
             (check (melissa-wait-until (lambda () (and result-a result-b))))
             (check (null failure-a))
             (check (null failure-b))
             (check (string= "person:slow"
                             (quasar.actors.melissa:canonical-entity-id result-a)))
             (check (string= "person:fast"
                             (quasar.actors.melissa:canonical-entity-id result-b)))))
      (ignore-errors (quasar.actors.melissa.bridge:stop-melissa-integration plane))
      (ignore-errors (quasar.control-plane:stop-control-plane plane)))))

(defun test-melissa-async-control-command ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.actors.melissa.bridge:start-melissa-integration
            plane
            :config (quasar.actors.melissa:make-melissa-config :license-key "test")
            :worker-count 2
            :transport #'fake-melissa-transport)
           (let* ((entity
                    (quasar.protocol:json-object
                     (cons "_id" "person:http")
                     (cons "dataset" "test")
                     (cons "dtype" "person")
                     (cons "title" "HTTP Person")
                     (cons "data" (quasar.protocol:json-object
                                   (cons "name" "HTTP Person")))
                     (cons "extensions" (quasar.protocol:json-object))))
                  (response
                    (call-command
                     plane
                     (make-envelope
                      "melissa.request"
                      (quasar.protocol:json-object
                       (cons "entity" entity)
                       (cons "options" (quasar.protocol:json-object)))
                      :id "melissa-http-1"))))
             (check response)
             (check (string= "ok" (status response)))
             (check (search "person:http" response)))
           (check (member "melissa.request"
                          (quasar.control-plane:control-plane-capabilities plane)
                          :test #'string=))
           (check (member "melissa.status"
                          (quasar.control-plane:control-plane-capabilities plane)
                          :test #'string=))
           (quasar.actors.melissa.bridge:stop-melissa-integration plane)
           (check (null (member "melissa.request"
                                (quasar.control-plane:control-plane-capabilities plane)
                                :test #'string=)))
           (check (null (member "melissa.status"
                                (quasar.control-plane:control-plane-capabilities plane)
                                :test #'string=))))
      (ignore-errors (quasar.actors.melissa.bridge:stop-melissa-integration plane))
      (ignore-errors (quasar.control-plane:stop-control-plane plane)))))

(defun test-melissa-stop-fails-pending-request ()
  (let* ((plane (quasar.control-plane:make-control-plane))
         (failure nil)
         (success nil))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (let* ((subsystem
                    (quasar.actors.melissa.bridge:start-melissa-integration
                     plane
                     :config (quasar.actors.melissa:make-melissa-config :license-key "test")
                     :worker-count 1
                     :transport #'fake-melissa-transport))
                  (bridge (quasar.actors.melissa:melissa-subsystem-http-bridge subsystem)))
             (sento.actor:tell
              bridge
              (quasar.actors.melissa:make-melissa-http-request
               :request-id "pending-stop"
               :entity (melissa-test-entity "person" "person:pending" "Pending")
               :options '(:delay-ms 1000)
               :on-success (lambda (entity) (setf success entity))
               :on-error (lambda (condition) (setf failure condition))))
             (quasar.actors.melissa.bridge:stop-melissa-integration plane)
             (check failure)
             (check (null success))
             (when failure
               (check (eq :bridge
                          (quasar.actors.melissa:melissa-error-stage failure)))
               (check (quasar.actors.melissa:melissa-error-retryable-p failure)))))
      (ignore-errors (quasar.actors.melissa.bridge:stop-melissa-integration plane))
      (ignore-errors (quasar.control-plane:stop-control-plane plane)))))

(defun test-melissa-all-error-record-set ()
  (let* ((system (sento.actor-system:make-actor-system))
         (subsystem
           (quasar.actors.melissa.supervisor:start-melissa-subsystem
            system
            :config (quasar.actors.melissa:make-melissa-config :license-key "test")
            :worker-count 1
            :transport #'all-error-melissa-transport))
         (requestor (make-melissa-collector system "melissa-all-error-requestor")))
    (unwind-protect
         (progn
           (sento.actor:tell
            (quasar.actors.melissa:melissa-subsystem-request-router subsystem)
            (quasar.actors.melissa:make-melissa-request
             :request-id "all-error"
             :requestor requestor
             :entity (melissa-test-entity "person" "person:error" "Error")
             :options nil))
           (check
            (melissa-wait-until
             (lambda ()
               (melissa-error-message "all-error"
                                      (melissa-collector-messages requestor)))))
           (let* ((messages (melissa-collector-messages requestor))
                  (failure (melissa-error-message "all-error" messages)))
             (check failure)
             (check (null (melissa-completed-message "all-error" messages)))
             (when failure
               (check (eq :normalize
                          (quasar.actors.melissa:melissa-error-stage failure)))
               (check (null
                       (quasar.actors.melissa:melissa-error-retryable-p failure))))))
      (quasar.actors.melissa.supervisor:stop-melissa-subsystem subsystem)
      (sento.actor-context:shutdown system :wait t))))

(defun run-melissa-tests ()
  (test-melissa-requestor-isolation-and-concurrency)
  (test-melissa-worker-recovery)
  (test-melissa-duplicate-external-request-ids)
  (test-melissa-async-control-command)
  (test-melissa-stop-fails-pending-request)
  (test-melissa-all-error-record-set)
  t)
