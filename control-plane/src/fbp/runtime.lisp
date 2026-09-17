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
  (activations 0 :type integer)
  (busy-p nil)
  pending-activation)

(defstruct activation
  instance
  (claims nil :type list)
  (inputs nil :type list)
  (emissions nil :type list))

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
  (packets-emitted 0 :type integer)
  (bytes-emitted 0 :type integer)
  (started-at (get-internal-real-time) :type integer)
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
        (runtime-trace runtime))
  (let ((maximum (limit-value (network-policy (runtime-network runtime))
                              :trace 1000)))
    (when (> (length (runtime-trace runtime)) maximum)
      (setf (runtime-trace runtime)
            (subseq (runtime-trace runtime) 0 maximum)))))

(defun runtime-elapsed-seconds (runtime)
  (/ (- (get-internal-real-time) (runtime-started-at runtime))
     internal-time-units-per-second))

(defun encoded-size (value)
  (length (with-output-to-string (stream)
            (let ((*print-readably* t) (*print-circle* t))
              (write value :stream stream)))))

(defun ensure-runtime-budget (runtime emissions)
  (let* ((policy (network-policy (runtime-network runtime)))
         (values (loop for emission in emissions append (cdr emission)))
         (packets (length values))
         (bytes (reduce #'+ values :key #'encoded-size :initial-value 0)))
    (when (> (+ (runtime-packets-emitted runtime) packets)
             (limit-value policy :packets 100000))
      (error 'sandbox-denied :code "fbp.packet-limit"
             :message "Workflow packet limit exceeded."))
    (when (> (+ (runtime-bytes-emitted runtime) bytes)
             (limit-value policy :bytes (* 64 1024 1024)))
      (error 'sandbox-denied :code "fbp.byte-limit"
             :message "Workflow byte limit exceeded."))
    (when (> (runtime-elapsed-seconds runtime)
             (limit-value policy :seconds 3600))
      (error 'sandbox-denied :code "fbp.time-limit"
             :message "Workflow wall-clock limit exceeded."))
    (values packets bytes)))

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

(defun make-runtime (network &key services grants)
  (ensure-runtime-capabilities network grants)
  (let ((runtime (%make-runtime :network (compile-network network)
                                :services services)))
    (build-runtime-indexes runtime)
    runtime))

(defun input-channel (runtime component port)
  (first (gethash (list component port) (runtime-inputs runtime))))

(defun ready-instance-p (runtime instance)
  (and
   (not (component-instance-busy-p instance))
   (every
    (lambda (port)
      (or (not (port-spec-required-p port))
          (let ((channel (input-channel runtime
                                        (component-spec-id (component-instance-spec instance))
                                        (port-spec-name port))))
            (and channel (channel-queue channel)))))
    (node-type-inputs (component-instance-type instance)))))

(defun claim-inputs (runtime instance)
  "Snapshot one activation's input packets without consuming them."
  (let ((claims nil)
        (inputs nil))
    (dolist (port (node-type-inputs (component-instance-type instance)))
      (let* ((channel (input-channel
                       runtime
                       (component-spec-id (component-instance-spec instance))
                       (port-spec-name port)))
             (packet (and channel (first (channel-queue channel)))))
        (when packet
          (push (cons channel packet) claims)
          (push (cons (port-spec-name port) (packet-value packet)) inputs))))
    (make-activation :instance instance
                     :claims (nreverse claims)
                     :inputs (nreverse inputs))))

(defun normalize-emissions (emissions)
  (loop for (port . values) in emissions
        collect (cons (canonical-name port)
                      (if (listp values) values (list values)))))

(defun validate-emissions (instance emissions)
  (dolist (emission emissions emissions)
    (unless (port-named (node-type-outputs (component-instance-type instance))
                        (car emission))
      (error 'fbp-error :code "fbp.invalid-emission"
             :message (format nil "Component emitted undeclared port ~A."
                              (car emission))))))

(defun emission-reservations (runtime instance emissions)
  "Return total packet demand per channel across the complete emission set."
  (let ((reservations (make-hash-table :test #'eq))
        (component (component-spec-id (component-instance-spec instance))))
    (dolist (emission emissions reservations)
      (dolist (channel (gethash (list component (car emission))
                                (runtime-outputs runtime)))
        (incf (gethash channel reservations 0) (length (cdr emission)))))))

(defun reservations-fit-p (reservations)
  (loop for channel being the hash-keys of reservations
          using (hash-value count)
        always (channel-space-p channel count)))

(defun claimed-inputs-intact-p (activation)
  (every (lambda (claim)
           (eq (cdr claim) (first (channel-queue (car claim)))))
         (activation-claims activation)))

(defun consume-claimed-inputs (activation)
  (dolist (claim (activation-claims activation))
    (unless (eq (channel-pop (car claim)) (cdr claim))
      (error 'fbp-error :code "fbp.activation-claim-lost"
             :message "A claimed input packet changed before commit."))))

(defun enqueue-emissions (runtime instance emissions)
  "Enqueue a preflighted emission set while the runtime lock is held."
  (let ((owner (component-spec-id (component-instance-spec instance))))
    (dolist (emission emissions)
      (let ((channels (gethash (list owner (car emission))
                               (runtime-outputs runtime))))
        (dolist (value (cdr emission))
          (let ((packet (make-packet :value value
                                     :owner owner
                                     :sequence (incf (runtime-sequence runtime)))))
            (dolist (channel channels)
              (channel-push channel packet))))))))

(defun commit-activation (runtime activation)
  "Atomically consume claimed inputs and publish every output, or do nothing."
  (let* ((instance (activation-instance activation))
         (emissions (activation-emissions activation))
         (reservations (emission-reservations runtime instance emissions)))
    (unless (claimed-inputs-intact-p activation)
      (setf (component-instance-busy-p instance) nil
            (component-instance-pending-activation instance) nil)
      (error 'fbp-error :code "fbp.activation-claim-lost"
             :message "A claimed input packet changed before commit."))
    (unless (reservations-fit-p reservations)
      (return-from commit-activation nil))
    (multiple-value-bind (packet-count byte-count)
        (ensure-runtime-budget runtime emissions)
      (consume-claimed-inputs activation)
      (enqueue-emissions runtime instance emissions)
      (incf (runtime-packets-emitted runtime) packet-count)
      (incf (runtime-bytes-emitted runtime) byte-count))
    (incf (component-instance-activations instance))
    (setf (component-instance-busy-p instance) nil
          (component-instance-pending-activation instance) nil)
    (runtime-record runtime :node-fired
                    :component (component-spec-id (component-instance-spec instance))
                    :activation (component-instance-activations instance))
    t))

(defun sorted-instances (runtime)
  (sort (loop for value being the hash-values of (runtime-instances runtime)
              collect value)
        #'string<
        :key (lambda (value)
               (component-spec-id (component-instance-spec value)))))

(defun commit-one-pending-activation (runtime)
  (dolist (instance (sorted-instances runtime))
    (let ((activation (component-instance-pending-activation instance)))
      (when (and activation (commit-activation runtime activation))
        (return-from commit-one-pending-activation t))))
  nil)

(defun claim-one-ready-activation (runtime)
  (dolist (instance (sorted-instances runtime))
    (when (ready-instance-p runtime instance)
      (let ((activation (claim-inputs runtime instance)))
        (setf (component-instance-busy-p instance) t)
        (return-from claim-one-ready-activation activation))))
  nil)

(defun release-failed-activation (runtime activation)
  (bt:with-lock-held ((runtime-lock runtime))
    (let ((instance (activation-instance activation)))
      (setf (component-instance-busy-p instance) nil
            (component-instance-pending-activation instance) nil))))

(defun process-activation (runtime activation)
  "Run component code outside the scheduler lock, then stage or commit output."
  (let* ((instance (activation-instance activation))
         (context (list :component (component-spec-id
                                    (component-instance-spec instance))
                        :config (component-spec-config
                                 (component-instance-spec instance))
                        :state (component-instance-state instance)
                        :services (runtime-services runtime)
                        :runtime runtime))
         (processor (node-type-processor (component-instance-type instance))))
    (handler-case
        (let ((emissions
                (validate-emissions
                 instance
                 (normalize-emissions
                  (and processor
                       (funcall processor (activation-inputs activation) context))))))
          (setf (activation-emissions activation) emissions)
          (bt:with-lock-held ((runtime-lock runtime))
            (setf (component-instance-pending-activation instance) activation)
            (commit-activation runtime activation)))
      (error (condition)
        (release-failed-activation runtime activation)
        (error condition)))))

(defun step-runtime (runtime &key (max-activations 1))
  "Commit at most MAX-ACTIVATIONS firings with lossless bounded backpressure.

The scheduler claims input packets under the runtime lock, invokes component
code without that lock, then atomically consumes inputs and publishes the full
emission set.  A blocked commit remains pending and is never reprocessed."
  (let ((fired 0))
    (loop while (< fired max-activations)
          do (let ((activation nil)
                   (committed nil))
               (bt:with-lock-held ((runtime-lock runtime))
                 (setf committed (commit-one-pending-activation runtime))
                 (unless committed
                   (setf activation (claim-one-ready-activation runtime))))
               (cond
                 (committed
                  (incf fired))
                 (activation
                  (when (process-activation runtime activation)
                    (incf fired)))
                 (t
                  (return)))))
    fired))

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
  (bt:with-lock-held ((runtime-lock runtime))
    (let ((blocked nil))
      (maphash
       (lambda (id instance)
         (let ((pending (component-instance-pending-activation instance)))
           (cond
             ((and pending
                   (not (reservations-fit-p
                         (emission-reservations
                          runtime instance (activation-emissions pending)))))
              (push (list :component id :reason :backpressure) blocked))
             ((not (ready-instance-p runtime instance))
              (push (list :component id :reason :waiting-for-input) blocked)))))
       (runtime-instances runtime))
      (nreverse blocked))))
