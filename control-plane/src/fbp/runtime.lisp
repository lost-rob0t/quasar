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

(defstruct activation-completion
  activation
  condition)

(defparameter *runtime-thread-factory*
  (lambda (function &key name)
    (bt:make-thread function :name name)))

(defstruct (runtime (:constructor %make-runtime))
  network
  (status :created)
  (services nil :type list)
  (host-limits '(:packets 100000 :bytes 67108864 :seconds 3600 :trace 1000
                 :concurrency 4)
               :type list)
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
  (worker-threads nil :type list)
  (work-queue nil :type list)
  (completion-queue nil :type list)
  (work-semaphore (bt:make-semaphore :count 0))
  (scheduler-semaphore (bt:make-semaphore :count 0))
  (workers-stop-signaled-p nil)
  (in-flight 0 :type integer)
  worker-error
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
  (let ((maximum (runtime-limit runtime :trace 1000)))
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

(defun runtime-limit (runtime key fallback)
  (let* ((host (or (getf (runtime-host-limits runtime) key) fallback))
         (requested (getf (sandbox-policy-limits
                           (network-policy (runtime-network runtime))) key)))
    (if requested (min requested host) host)))

(defun validate-runtime-limits (limits)
  (unless (and (listp limits) (evenp (length limits)))
    (error 'validation-error :code "fbp.invalid-limits"
           :message "Runtime limits must be a property list."))
  (loop for (key value) on limits by #'cddr
        do (unless (member key '(:packets :bytes :seconds :trace :concurrency))
             (error 'validation-error :code "fbp.unknown-limit"
                    :message (format nil "Unknown runtime limit ~A." key)))
           (unless (and (integerp value) (plusp value))
             (error 'validation-error :code "fbp.invalid-limit"
                    :message (format nil "Runtime limit ~A must be a positive integer."
                                     key))))
  limits)

(defun map-emission-deliveries (runtime instance emissions function)
  (let ((component (component-spec-id (component-instance-spec instance))))
    (dolist (emission emissions)
      (dolist (channel (gethash (list component (car emission))
                                (runtime-outputs runtime)))
        (dolist (value (cdr emission))
          (funcall function channel value))))))

(defun ensure-runtime-budget (runtime instance emissions)
  (let ((packets 0)
        (bytes 0))
    (map-emission-deliveries
     runtime instance emissions
     (lambda (channel value)
       (declare (ignore channel))
       (incf packets)
       (incf bytes (encoded-size value))))
    (when (> (+ (runtime-packets-emitted runtime) packets)
             (runtime-limit runtime :packets 100000))
      (error 'sandbox-denied :code "fbp.packet-limit"
             :message "Workflow packet limit exceeded."))
    (when (> (+ (runtime-bytes-emitted runtime) bytes)
             (runtime-limit runtime :bytes (* 64 1024 1024)))
      (error 'sandbox-denied :code "fbp.byte-limit"
             :message "Workflow byte limit exceeded."))
    (when (> (runtime-elapsed-seconds runtime)
             (runtime-limit runtime :seconds 3600))
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

(defun make-runtime (network &key services grants host-limits)
  (ensure-runtime-capabilities network grants)
  (validate-runtime-limits (sandbox-policy-limits (network-policy network)))
  (validate-runtime-limits (or host-limits
                               '(:packets 100000 :bytes 67108864 :seconds 3600
                                 :trace 1000 :concurrency 4)))
  (let ((runtime (%make-runtime :network (compile-network network)
                                :services services
                                :host-limits (or host-limits
                                                 '(:packets 100000 :bytes 67108864
                                                   :seconds 3600 :trace 1000
                                                   :concurrency 4)))))
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
    (map-emission-deliveries
     runtime instance emissions
     (lambda (channel value)
       (channel-push channel
                     (make-packet :value value :owner owner
                                  :sequence (incf (runtime-sequence runtime))))))))

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
        (ensure-runtime-budget runtime instance emissions)
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

(defun evaluate-activation (runtime activation)
  "Run component code without mutating scheduler state."
  (let* ((instance (activation-instance activation))
         (context (list :component (component-spec-id
                                    (component-instance-spec instance))
                        :config (component-spec-config
                                 (component-instance-spec instance))
                        :state (component-instance-state instance)
                        :services (runtime-services runtime)
                        :runtime runtime))
         (processor (node-type-processor (component-instance-type instance))))
    (setf (activation-emissions activation)
          (validate-emissions
           instance
           (normalize-emissions
            (and processor
                 (funcall processor (activation-inputs activation) context)))))
    activation))

(defun process-activation (runtime activation)
  "Evaluate outside the lock and commit synchronously for deterministic stepping."
  (handler-case
      (progn
        (evaluate-activation runtime activation)
        (bt:with-lock-held ((runtime-lock runtime))
          (setf (component-instance-pending-activation
                 (activation-instance activation)) activation)
          (commit-activation runtime activation)))
    (error (condition)
      (release-failed-activation runtime activation)
      (error condition))))

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

(defun queue-append (queue value)
  (nconc queue (list value)))

(defun cancel-activation (activation)
  (let ((instance (activation-instance activation)))
    (setf (component-instance-busy-p instance) nil
          (component-instance-pending-activation instance) nil)))

(defun cancel-queued-work-locked (runtime)
  (dolist (activation (runtime-work-queue runtime))
    (cancel-activation activation)
    (decf (runtime-in-flight runtime)))
  (setf (runtime-work-queue runtime) nil))

(defun cancel-pending-activations-locked (runtime)
  (maphash
   (lambda (id instance)
     (declare (ignore id))
     (when (component-instance-pending-activation instance)
       (setf (component-instance-pending-activation instance) nil
             (component-instance-busy-p instance) nil)))
   (runtime-instances runtime)))

(defun signal-worker-stop (runtime)
  "Wake each persistent worker exactly once after stop has been requested."
  (let ((count 0))
    (bt:with-lock-held ((runtime-lock runtime))
      (unless (runtime-workers-stop-signaled-p runtime)
        (setf (runtime-workers-stop-signaled-p runtime) t
              count (length (runtime-worker-threads runtime)))))
    (loop repeat count
          do (bt:signal-semaphore (runtime-work-semaphore runtime)))
    (bt:signal-semaphore (runtime-scheduler-semaphore runtime))))

(defun request-runtime-stop (runtime)
  "Request cooperative shutdown without waiting for any thread."
  (bt:with-lock-held ((runtime-lock runtime))
    (setf (runtime-stop-p runtime) t)
    (unless (eq (runtime-status runtime) :failed)
      (setf (runtime-status runtime) :stopping))
    (cancel-queued-work-locked runtime)
    (cancel-pending-activations-locked runtime))
  (signal-worker-stop runtime)
  runtime)

(defun take-work (runtime)
  (bt:with-lock-held ((runtime-lock runtime))
    (let ((activation (pop (runtime-work-queue runtime))))
      (values activation (runtime-stop-p runtime)))))

(defun publish-completion (runtime completion)
  (bt:with-lock-held ((runtime-lock runtime))
    (setf (runtime-completion-queue runtime)
          (queue-append (runtime-completion-queue runtime) completion)))
  (bt:signal-semaphore (runtime-scheduler-semaphore runtime)))

(defun activation-worker-loop (runtime)
  (loop
    (bt:wait-on-semaphore (runtime-work-semaphore runtime))
    (multiple-value-bind (activation stopping-p) (take-work runtime)
      (cond
        (activation
         (publish-completion
          runtime
          (handler-case
              (progn
                (evaluate-activation runtime activation)
                (make-activation-completion :activation activation))
            (error (condition)
              (make-activation-completion :activation activation
                                          :condition condition)))))
        (stopping-p
         (return))))))

(defun join-threads (threads)
  "Join THREADS without holding a runtime or manager lock."
  (let ((current (bt:current-thread)))
    (dolist (thread threads)
      (when (and thread (not (eq thread current)))
        (bt:join-thread thread)))))

(defun start-worker-pool (runtime)
  "Start the complete fixed-size pool before the scheduler can claim inputs."
  (let ((started nil)
        (count (runtime-limit runtime :concurrency 4)))
    (handler-case
        (dotimes (index count)
          (let ((thread
                  (funcall *runtime-thread-factory*
                           (lambda () (activation-worker-loop runtime))
                           :name (format nil "quasar-fbp-worker-~D" index))))
            (push thread started)
            (bt:with-lock-held ((runtime-lock runtime))
              (setf (runtime-worker-threads runtime) (reverse started)))))
      (error (condition)
        (request-runtime-stop runtime)
        (join-threads started)
        (bt:with-lock-held ((runtime-lock runtime))
          (setf (runtime-worker-threads runtime) nil))
        (error condition)))
    (nreverse started)))

(defun drain-completions-locked (runtime)
  "Stage successful completions, or cancel all work after the first failure."
  (let* ((completions (prog1 (runtime-completion-queue runtime)
                        (setf (runtime-completion-queue runtime) nil)))
         (condition (or (runtime-worker-error runtime)
                        (loop for completion in completions
                              thereis (activation-completion-condition completion)))))
    (when condition
      (setf (runtime-worker-error runtime) condition
            (runtime-stop-p runtime) t)
      (cancel-queued-work-locked runtime)
      (cancel-pending-activations-locked runtime))
    (dolist (completion completions)
      (let* ((activation (activation-completion-activation completion))
             (instance (activation-instance activation)))
        (decf (runtime-in-flight runtime))
        (if (or condition (runtime-stop-p runtime))
            (cancel-activation activation)
            (setf (component-instance-pending-activation instance) activation))))
    (values (not (null completions)) condition)))

(defun dispatch-ready-activations-locked (runtime)
  (let ((count 0))
    (loop while (< (runtime-in-flight runtime)
                   (runtime-limit runtime :concurrency 4))
          for activation = (claim-one-ready-activation runtime)
          while activation
          do (incf (runtime-in-flight runtime))
             (incf count)
             (setf (runtime-work-queue runtime)
                   (queue-append (runtime-work-queue runtime) activation)))
    count))

(defun signal-work (runtime count)
  (loop repeat count
        do (bt:signal-semaphore (runtime-work-semaphore runtime))))

(defun await-in-flight (runtime)
  "Drain worker completions after stop/failure until no activation is running."
  (loop
    (let ((done nil))
      (bt:with-lock-held ((runtime-lock runtime))
        (drain-completions-locked runtime)
        (setf done (zerop (runtime-in-flight runtime))))
      (when done (return))
      (bt:wait-on-semaphore (runtime-scheduler-semaphore runtime) :timeout 0.05))))

(defun runtime-loop (runtime)
  (bt:with-lock-held ((runtime-lock runtime))
    (setf (runtime-status runtime) :running)
    (runtime-record runtime :run-started))
  (handler-case
      (loop
        (let ((progress nil)
              (dispatch-count 0)
              (done nil)
              (worker-error nil))
          (bt:with-lock-held ((runtime-lock runtime))
            (multiple-value-bind (completed condition)
                (drain-completions-locked runtime)
              (setf progress completed
                    worker-error condition))
            (unless (runtime-stop-p runtime)
              (loop while (commit-one-pending-activation runtime)
                    do (setf progress t))
              (setf dispatch-count (dispatch-ready-activations-locked runtime)))
            (setf done (and (runtime-stop-p runtime)
                            (zerop (runtime-in-flight runtime)))))
          (when worker-error (error worker-error))
          (signal-work runtime dispatch-count)
          (when (> (runtime-elapsed-seconds runtime)
                   (runtime-limit runtime :seconds 3600))
            (error 'sandbox-denied :code "fbp.time-limit"
                   :message "Workflow wall-clock limit exceeded."))
          (when done (return))
          (unless (or progress (plusp dispatch-count))
            (bt:wait-on-semaphore (runtime-scheduler-semaphore runtime)
                                  :timeout 0.05))))
    (error (condition)
      (bt:with-lock-held ((runtime-lock runtime))
        (setf (runtime-status runtime) :failed
              (runtime-worker-error runtime) condition)
        (runtime-record runtime :run-failed :message (princ-to-string condition)))
      (request-runtime-stop runtime)))
  (request-runtime-stop runtime)
  (await-in-flight runtime)
  (let ((workers (bt:with-lock-held ((runtime-lock runtime))
                   (copy-list (runtime-worker-threads runtime)))))
    (join-threads workers))
  (bt:with-lock-held ((runtime-lock runtime))
    (setf (runtime-worker-threads runtime) nil)
    (unless (eq (runtime-status runtime) :failed)
      (setf (runtime-status runtime) :stopped)
      (runtime-record runtime :run-stopped))))

(defun start-runtime (runtime &key (background t))
  (when (member (runtime-status runtime) '(:running :starting))
    (return-from start-runtime runtime))
  (bt:with-lock-held ((runtime-lock runtime))
    (setf (runtime-stop-p runtime) nil
          (runtime-worker-error runtime) nil
          (runtime-workers-stop-signaled-p runtime) nil
          (runtime-work-queue runtime) nil
          (runtime-completion-queue runtime) nil
          (runtime-in-flight runtime) 0
          (runtime-status runtime) :starting))
  (handler-case
      (progn
        (start-worker-pool runtime)
        (if background
            (setf (runtime-thread runtime)
                  (funcall *runtime-thread-factory*
                           (lambda () (runtime-loop runtime))
                           :name (format nil "quasar-fbp-~A"
                                         (network-id (runtime-network runtime)))))
            (runtime-loop runtime)))
    (error (condition)
      (bt:with-lock-held ((runtime-lock runtime))
        (setf (runtime-status runtime) :failed))
      (request-runtime-stop runtime)
      (let ((workers (bt:with-lock-held ((runtime-lock runtime))
                       (copy-list (runtime-worker-threads runtime)))))
        (join-threads workers))
      (bt:with-lock-held ((runtime-lock runtime))
        (setf (runtime-worker-threads runtime) nil
              (runtime-thread runtime) nil
              (runtime-in-flight runtime) 0)
        (maphash (lambda (id instance)
                   (declare (ignore id))
                   (setf (component-instance-busy-p instance) nil
                         (component-instance-pending-activation instance) nil))
                 (runtime-instances runtime)))
      (error condition)))
  runtime)

(defun stop-runtime (runtime)
  (request-runtime-stop runtime)
  (let ((current (bt:current-thread)))
    (labels ((live-threads ()
               (remove-if-not
                (lambda (thread)
                  (and thread (not (eq thread current))
                       (bt:thread-alive-p thread)))
                (cons (runtime-thread runtime)
                      (copy-list (runtime-worker-threads runtime))))))
      (loop repeat 500
            while (live-threads)
            do (sleep 0.01))
      (when (live-threads)
        (bt:with-lock-held ((runtime-lock runtime))
          (unless (eq (runtime-status runtime) :failed)
            (setf (runtime-status runtime) :stopping)))
        (error 'fbp-error :code "fbp.stop-timeout"
               :message "Workflow did not stop within five seconds."))))
  (let ((threads (bt:with-lock-held ((runtime-lock runtime))
                   (remove nil
                           (cons (runtime-thread runtime)
                                 (copy-list (runtime-worker-threads runtime)))))))
    (join-threads threads))
  (bt:with-lock-held ((runtime-lock runtime))
    (setf (runtime-thread runtime) nil
          (runtime-worker-threads runtime) nil))
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
