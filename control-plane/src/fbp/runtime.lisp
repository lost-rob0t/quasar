(in-package #:quasar.fbp)

(defstruct packet
  value
  (owner "runtime" :type string)
  (sequence 0 :type integer)
  (created-at (get-universal-time) :type integer))

(defstruct channel
  spec
  (queue nil :type list))

(defstruct component-instance
  spec
  type
  (state nil :type list)
  (activations 0 :type integer))

(defstruct (runtime (:constructor %make-runtime))
  network
  (status :created)
  (services nil :type list)
  (instances (make-hash-table :test #'equal))
  (inputs (make-hash-table :test #'equal))
  (outputs (make-hash-table :test #'equal))
  (channels nil :type list)
  (trace nil :type list)
  (sequence 0 :type integer)
  thread
  (stop-p nil)
  (lock (bt:make-lock "quasar-fbp-runtime")))

(defun channel-size (channel)
  (length (channel-queue channel)))

(defun channel-capacity (channel)
  (connection-spec-capacity (channel-spec channel)))

(defun channel-space-p (channel count)
  (<= (+ (channel-size channel) count) (channel-capacity channel)))

(defun channel-push (channel packet)
  (unless (channel-space-p channel 1)
    (error 'backpressure :code "fbp.backpressure"
           :message "A bounded FBP connection is full."))
  (setf (channel-queue channel)
        (nconc (channel-queue channel) (list packet)))
  packet)

(defun channel-pop (channel)
  (let ((packet (first (channel-queue channel))))
    (when packet
      (setf (channel-queue channel) (rest (channel-queue channel))))
    packet))

(defun runtime-record (runtime event &rest fields)
  (push (list* :event event :at (get-universal-time) fields)
        (runtime-trace runtime)))

(defun build-runtime-indexes (runtime)
  (dolist (component (network-components (runtime-network runtime)))
    (setf (gethash (component-spec-id component) (runtime-instances runtime))
          (make-component-instance
           :spec component
           :type (find-node-type (component-spec-type component)))))
  (dolist (spec (network-connections (runtime-network runtime)))
    (let ((channel (make-channel :spec spec)))
      (push channel (runtime-channels runtime))
      (push channel (gethash (list (connection-spec-to spec)
                                   (connection-spec-in spec))
                             (runtime-inputs runtime)))
      (push channel (gethash (list (connection-spec-from spec)
                                   (connection-spec-out spec))
                             (runtime-outputs runtime)))))
  (dolist (iip (network-iips (runtime-network runtime)))
    (let* ((spec (make-connection-spec :from "@iip" :out "out"
                                      :to (iip-spec-to iip) :in (iip-spec-in iip)
                                      :capacity 1))
           (channel (make-channel :spec spec)))
      (push channel (runtime-channels runtime))
      (push channel (gethash (list (iip-spec-to iip) (iip-spec-in iip))
                             (runtime-inputs runtime)))
      (channel-push channel (make-packet :value (iip-spec-value iip)
                                        :owner "@iip" :sequence 0))))
  runtime)

(defun make-runtime (network &key services)
  (ensure-runtime-capabilities network)
  (let ((runtime (%make-runtime :network (compile-network network)
                                :services services)))
    (build-runtime-indexes runtime)
    runtime))

(defun input-channel (runtime component port)
  (first (gethash (list component port) (runtime-inputs runtime))))

(defun ready-instance-p (runtime instance)
  (every
   (lambda (port)
     (or (not (port-spec-required-p port))
         (let ((channel (input-channel runtime
                                       (component-spec-id (component-instance-spec instance))
                                       (port-spec-name port))))
           (and channel (channel-queue channel)))))
   (node-type-inputs (component-instance-type instance))))

(defun outputs-have-space-p (runtime instance)
  (every
   (lambda (port)
     (every (lambda (channel) (channel-space-p channel 1))
            (gethash (list (component-spec-id (component-instance-spec instance))
                           (port-spec-name port))
                     (runtime-outputs runtime))))
   (node-type-outputs (component-instance-type instance))))

(defun take-inputs (runtime instance)
  (loop for port in (node-type-inputs (component-instance-type instance))
        for channel = (input-channel runtime
                                     (component-spec-id (component-instance-spec instance))
                                     (port-spec-name port))
        for packet = (and channel (channel-pop channel))
        when packet collect (cons (port-spec-name port) (packet-value packet))))

(defun normalize-emissions (emissions)
  (loop for (port . values) in emissions
        collect (cons (canonical-name port)
                      (if (listp values) values (list values)))))

(defun emit-values (runtime instance emissions)
  "Reserve every fan-out destination before enqueueing, preventing partial fan-out."
  (dolist (emission (normalize-emissions emissions))
    (let* ((port (car emission))
           (values (cdr emission))
           (channels (gethash (list (component-spec-id (component-instance-spec instance)) port)
                              (runtime-outputs runtime))))
      (unless (port-named (node-type-outputs (component-instance-type instance)) port)
        (error 'fbp-error :code "fbp.invalid-emission"
               :message (format nil "Component emitted undeclared port ~A." port)))
      (unless (every (lambda (channel) (channel-space-p channel (length values))) channels)
        (error 'backpressure :code "fbp.backpressure"
               :message "Atomic fan-out could not reserve every bounded connection."))
      (dolist (value values)
        (let ((sequence (incf (runtime-sequence runtime))))
          (dolist (channel channels)
            (channel-push channel
                          (make-packet :value value
                                       :owner (component-spec-id
                                               (component-instance-spec instance))
                                       :sequence sequence))))))))

(defun activate-instance (runtime instance)
  (let* ((inputs (take-inputs runtime instance))
         (context (list :component (component-spec-id (component-instance-spec instance))
                        :config (component-spec-config (component-instance-spec instance))
                        :state (component-instance-state instance)
                        :services (runtime-services runtime)
                        :runtime runtime))
         (processor (node-type-processor (component-instance-type instance)))
         (emissions (and processor (funcall processor inputs context))))
    (incf (component-instance-activations instance))
    (emit-values runtime instance emissions)
    (runtime-record runtime :node-fired
                    :component (component-spec-id (component-instance-spec instance))
                    :activation (component-instance-activations instance))
    t))

(defun step-runtime (runtime &key (max-activations 1))
  "Run at most MAX-ACTIVATIONS deterministic component firings."
  (bt:with-lock-held ((runtime-lock runtime))
    (let ((fired 0))
      (dolist (instance (sort (loop for value being the hash-values
                                      of (runtime-instances runtime) collect value)
                              #'string< :key (lambda (value)
                                               (component-spec-id
                                                (component-instance-spec value)))))
        (when (and (< fired max-activations)
                   (ready-instance-p runtime instance)
                   (outputs-have-space-p runtime instance))
          (activate-instance runtime instance)
          (incf fired)))
      fired)))

(defun runtime-loop (runtime)
  (setf (runtime-status runtime) :running)
  (runtime-record runtime :run-started)
  (handler-case
      (loop until (runtime-stop-p runtime)
            for fired = (step-runtime runtime :max-activations 128)
            do (when (zerop fired) (sleep 0.001)))
    (error (condition)
      (setf (runtime-status runtime) :failed)
      (runtime-record runtime :run-failed :message (princ-to-string condition))))
  (unless (eq (runtime-status runtime) :failed)
    (setf (runtime-status runtime) :stopped)
    (runtime-record runtime :run-stopped)))

(defun start-runtime (runtime &key (background t))
  (when (member (runtime-status runtime) '(:running :starting))
    (return-from start-runtime runtime))
  (setf (runtime-stop-p runtime) nil
        (runtime-status runtime) :starting)
  (if background
      (setf (runtime-thread runtime)
            (bt:make-thread (lambda () (runtime-loop runtime))
                            :name (format nil "quasar-fbp-~A"
                                          (network-id (runtime-network runtime)))))
      (runtime-loop runtime))
  runtime)

(defun stop-runtime (runtime)
  (setf (runtime-stop-p runtime) t)
  (let ((thread (runtime-thread runtime)))
    (when (and thread (bt:thread-alive-p thread)
               (not (eq thread (bt:current-thread))))
      (bt:join-thread thread)))
  (setf (runtime-thread runtime) nil)
  runtime)

(defun inject-packet (runtime component port value)
  (bt:with-lock-held ((runtime-lock runtime))
    (let ((channel (input-channel runtime (canonical-name component) (canonical-name port))))
      (unless channel
        (error 'validation-error :code "fbp.unknown-input"
               :message (format nil "Unknown runtime input ~A.~A." component port)))
      (channel-push channel
                    (make-packet :value value :owner "@external"
                                 :sequence (incf (runtime-sequence runtime)))))))

(defun runtime-deadlock-report (runtime)
  (let ((blocked nil))
    (maphash
     (lambda (id instance)
       (unless (ready-instance-p runtime instance)
         (push (list :component id :reason :waiting-for-input) blocked))
       (unless (outputs-have-space-p runtime instance)
         (push (list :component id :reason :backpressure) blocked)))
     (runtime-instances runtime))
    (nreverse blocked)))
