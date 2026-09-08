(in-package #:quasar.tests)

;;; Tests for the quasar.log facility (log4cl-backed). Every test
;;; configures its sink explicitly so results are independent of the
;;; environment's QUASAR_LOG_LEVEL.

(defclass capture-appender (log4cl:appender)
  ((records :initform (make-array 0 :adjustable t :fill-pointer 0)
            :accessor capture-records)
   (lock :initform (bt:make-lock "quasar-capture-appender")
         :reader capture-appender-lock))
  (:documentation "Test sink: one rendered record per captured slot."))

(defmethod log4cl:appender-do-append ((appender capture-appender)
                                      logger level log-func)
  (let ((text (with-output-to-string (stream)
                (log4cl:layout-to-stream
                 (log4cl:appender-layout appender)
                 stream logger level log-func))))
    (bt:with-lock-held ((capture-appender-lock appender))
      (vector-push-extend text (capture-records appender)))))

(defun capture-record-count (capture)
  (length (capture-records capture)))

(defun capture-contains (capture substring)
  (loop for record across (capture-records capture)
        when (search substring record)
          do (return t)))

(defun attach-capture (layout)
  "Configure a clean off sink at debug level, then attach CAPTURE."
  (quasar.log:apply-config :sink :off :level :debug)
  (let ((capture (make-instance 'capture-appender :layout layout)))
    (log4cl:add-appender (quasar.log:event-logger) capture)
    capture))

(defun test-default-config-selects-stdout ()
  (quasar.config:reset-config)
  (quasar.log:apply-config)
  (let* ((appenders (log4cl:logger-appenders (quasar.log:event-logger)))
         (appender (first appenders)))
    (check (= (length appenders) 1))
    (check (typep appender 'log4cl:fixed-stream-appender))
    (check (eq (log4cl:appender-stream appender) *standard-output*))
    (check (typep (log4cl:appender-layout appender) 'quasar.log:text-layout))))

(defun test-init-override-selects-file-sink ()
  (let ((path (uiop:merge-pathnames*
               "quasar-logging-test-override.log"
               (uiop:ensure-directory-pathname "/tmp/opencode/"))))
    (ensure-directories-exist path)
    (ignore-errors (delete-file path))
    (quasar.config:reset-config)
    (setf quasar.config:*log-sink* :file
          quasar.config:*log-file-path* path
          quasar.config:*log-level* :debug)
    (let ((level (quasar.log:apply-config)))
      (check (eq level :debug))
      (let ((appenders (log4cl:logger-appenders (quasar.log:event-logger))))
        (check (= (length appenders) 1))
        (check (typep (first appenders) 'log4cl:file-appender))
        (check (uiop:pathname-equal
                (log4cl:appender-filename (first appenders)) path))
        (quasar.log:log-event :info "test" "override" :k "v")
        (quasar.log:flush-logs)
        (check (probe-file path))
        (let ((record (first (uiop:read-file-lines path))))
          (check (not (null record)))
          (let ((parsed (jsown:parse record)))
            (check (string= (jsown:val parsed "subsystem") "test"))
            (check (string= (jsown:val parsed "event") "override"))
            (check (string= (jsown:val parsed "level") "info"))
            (check (string= (jsown:val (jsown:val parsed "fields") "k") "v"))))))))

(defun test-log-level-filtering ()
  (quasar.log:apply-config :sink :off :level :warn)
  (let ((capture (make-instance 'capture-appender
                                :layout (quasar.log:make-json-lines-layout))))
    (log4cl:add-appender (quasar.log:event-logger) capture)
    (quasar.log:log-event :debug "test" "filtered-debug")
    (quasar.log:log-event :info "test" "filtered-info")
    (quasar.log:log-event :warn "test" "visible-warn")
    (quasar.log:log-event :error "test" "visible-error")
    (check (= (capture-record-count capture) 2))
    (check (capture-contains capture "visible-warn"))
    (check (capture-contains capture "visible-error"))
    (check (not (capture-contains capture "filtered-debug")))
    (check (not (capture-contains capture "filtered-info")))))

(defun test-structured-fields-text ()
  (let ((capture (attach-capture (quasar.log:make-text-layout))))
    (quasar.control-plane::diagnostic-log
     :debug "control-plane" "command.received"
     :request-id "req-42" :command "document.get" :workspace "ws-1"
     :client "quasar-tests")
    (check (= (capture-record-count capture) 1))
    (check (capture-contains capture "control-plane command.received"))
    (check (capture-contains capture " DEBUG "))
    (check (search "[quasar] " (aref (capture-records capture) 0)))
    (check (capture-contains capture "REQUEST-ID=\"req-42\""))
    (check (capture-contains capture "COMMAND=\"document.get\""))
    (check (capture-contains capture "WORKSPACE=\"ws-1\""))))

(defun test-structured-fields-json ()
  (let ((capture (attach-capture (quasar.log:make-json-lines-layout))))
    (quasar.log:log-event
     :error "control-plane" "command.failed"
     :request-id "req-7" :workspace "ws-7"
     :message "The command could not be processed."
     :code "document.not-found"
     :details (quasar.protocol:json-object (cons "op" 1)))
    (check (= (capture-record-count capture) 1))
    (let ((record (jsown:parse (aref (capture-records capture) 0))))
      (check (plusp (length (jsown:val record "timestamp"))))
      (check (string= (jsown:val record "level") "error"))
      (check (string= (jsown:val record "subsystem") "control-plane"))
      (check (string= (jsown:val record "event") "command.failed"))
      (check (string= (jsown:val record "message")
                      "The command could not be processed."))
      (check (string= (jsown:val record "request_id") "req-7"))
      (check (string= (jsown:val record "workspace_id") "ws-7"))
      (let ((fields (jsown:val record "fields")))
        (check (string= (jsown:val fields "code") "document.not-found"))
        (check (= (jsown:val (jsown:val fields "details") "op") 1))))))

(defun test-error-and-fatal-logging ()
  (let ((capture (attach-capture (quasar.log:make-json-lines-layout))))
    (quasar.log:log-error "workspace" "operation.failed" :code "graph.invalid-reference")
    (quasar.log:log-fatal "app" "fatal" :condition "terminal")
    (check (= (capture-record-count capture) 2))
    (let ((error-record (jsown:parse (aref (capture-records capture) 0)))
          (fatal-record (jsown:parse (aref (capture-records capture) 1))))
      (check (string= (jsown:val error-record "level") "error"))
      (check (string= (jsown:val fatal-record "level") "fatal"))
      (check (string= (jsown:val fatal-record "event") "fatal")))))

(defun test-concurrent-writes-are-line-complete ()
  "Concurrent Sento-style actor threads must produce one complete,
un-interleaved JSON record per line."
  (let ((path (uiop:merge-pathnames*
               "quasar-logging-test-concurrent.log"
               (uiop:ensure-directory-pathname "/tmp/opencode/"))))
    (ensure-directories-exist path)
    (ignore-errors (delete-file path))
    (quasar.log:apply-config :sink :file :file-path path :file-format :json)
    (let* ((threads 4)
           (per-thread 100)
           (workers
             (loop for worker in (list 1 2 3 4)
                   collect (let ((worker worker))
                             (bt:make-thread
                              (lambda ()
                                (loop for n from 1 to per-thread
                                      do (quasar.log:log-event
                                          :info "concurrency" "event"
                                          :worker worker :n n
                                          :message "concurrent record text"))))))))
      (mapc #'bt:join-thread workers)
      (quasar.log:flush-logs)
      (let* ((lines (uiop:read-file-lines path))
             (expected (* threads per-thread)))
        (check (= (length lines) expected))
        (check (loop for line in lines
                     always (ignore-errors
                              (let ((parsed (jsown:parse line)))
                                (and (string= (jsown:val parsed "subsystem")
                                              "concurrency")
                                     (string= (jsown:val parsed "event") "event"))))))
        (let ((worker-ids
                (loop for line in lines
                      collect (jsown:val (jsown:val (jsown:parse line) "fields") "worker"))))
          (check (equal (sort worker-ids #'<) (append (make-list per-thread :initial-element 1)
                                                      (make-list per-thread :initial-element 2)
                                                      (make-list per-thread :initial-element 3)
                                                      (make-list per-thread :initial-element 4)))))))))

(defun test-restart-persistence ()
  "A durable sink appends across logging sessions, so records
survive a process restart configuration cycle."
  (let ((path (uiop:merge-pathnames*
               "quasar-logging-test-restart.log"
               (uiop:ensure-directory-pathname "/tmp/opencode/"))))
    (ensure-directories-exist path)
    (ignore-errors (delete-file path))
    (quasar.log:apply-config :sink :file :file-path path :file-format :json)
    (quasar.log:log-event :info "persistence" "first-session")
    (quasar.log:shutdown-logging)
    (quasar.log:apply-config :sink :file :file-path path :file-format :json)
    (quasar.log:log-event :info "persistence" "second-session")
    (quasar.log:shutdown-logging)
    (let ((lines (uiop:read-file-lines path)))
      (check (= (length lines) 2))
      (check (search "first-session" (first lines)))
      (check (search "second-session" (second lines))))))

(defun test-flush-and-shutdown-behavior ()
  (let ((path (uiop:merge-pathnames*
               "quasar-logging-test-flush.log"
               (uiop:ensure-directory-pathname "/tmp/opencode/"))))
    (ensure-directories-exist path)
    (ignore-errors (delete-file path))
    ;; Relaxed flush policy: buffered in userspace until flushed.
    (quasar.log:apply-config :sink :file :file-path path
                             :file-format :json :immediate-flush nil)
    (quasar.log:log-event :info "flush" "buffered-record")
    (quasar.log:flush-logs)
    (let ((lines (uiop:read-file-lines path)))
      (check (= (length lines) 1))
      (check (search "buffered-record" (first lines))))
    ;; Shutdown detaches the sink; later events are safely dropped.
    (quasar.log:shutdown-logging)
    (check (= (length (log4cl:logger-appenders (quasar.log:event-logger))) 0))
    (quasar.log:log-event :info "flush" "after-shutdown")
    (check (= (length (uiop:read-file-lines path)) 1))))

(defclass failing-appender (log4cl:appender)
  ()
  (:documentation "Test sink that always fails, proving that sink
errors never reach the logging caller."))

(defmethod log4cl:appender-do-append ((appender failing-appender)
                                      logger level log-func)
  (declare (ignore logger level log-func appender))
  (error "injected sink failure"))

(defun test-sink-failure-does-not-signal ()
  (quasar.log:apply-config :sink :off :level :debug)
  (log4cl:add-appender (quasar.log:event-logger)
                       (make-instance 'failing-appender))
  ;; The log call must never propagate sink errors to the caller.
  (check (null (quasar.log:log-event :error "test" "sink-failure" :k "v")))
  (log4cl:remove-all-appenders (quasar.log:event-logger)))

(defun test-invalid-configuration-fails-closed ()
  (quasar.config:reset-config)
  (let ((appenders-before (log4cl:logger-appenders (quasar.log:event-logger))))
    (flet ((expect-config-error (thunk)
             (handler-case (progn (funcall thunk) nil)
               (quasar.log:log-config-error (condition) condition))))
      (check (expect-config-error
              (lambda () (quasar.log:apply-config :sink :carrier))))
      (check (expect-config-error
              (lambda () (quasar.log:apply-config :level :banana))))
      (check (expect-config-error
              (lambda () (quasar.log:apply-config :file-format :xml))))
      (check (expect-config-error
              (lambda () (quasar.log:apply-config :sink :file :file-path ""))))
      ;; Failed configuration must not leave a half-configured sink.
      (check (equal appenders-before
                    (log4cl:logger-appenders (quasar.log:event-logger)))))))

(defun test-event-vocabulary-compat ()
  "The dispatch instrumentation keeps the historical
control-plane command.* events."
  (let ((capture (attach-capture (quasar.log:make-text-layout)))
        (plane (quasar.control-plane:make-control-plane))
        (response nil))
    (quasar.control-plane:register-command
     plane "system.capabilities"
     (lambda (payload envelope)
       (declare (ignore payload envelope))
       (quasar.protocol:json-array)))
    (quasar.control-plane::dispatch-message
     plane
     (list :envelope (quasar.protocol:make-command-envelope
                      :id "req-1" :command "system.capabilities"
                      :payload (quasar.protocol:empty-object)
                      :workspace "default"
                      :client "quasar-tests")
           :reply (lambda (encoded) (setf response encoded))))
    (check (not (null response)))
    (check (= (capture-record-count capture) 2))
    (check (capture-contains capture "control-plane command.received"))
    (check (capture-contains capture "control-plane command.ok"))))

(defun test-workspace-operation-events ()
  "Workspace commit diagnostics keep operation.begin/operation.applied."
  (let ((capture (attach-capture (quasar.log:make-text-layout)))
        (workspace (quasar.workspace:make-workspace :id "logging-ws-test")))
    (quasar.workspace:commit-operations
     workspace
     (list (quasar.protocol:json-object
            (cons "type" "document.create")
            (cons "payload"
                  (quasar.protocol:json-object
                   (cons "dtype" "note")
                   (cons "body" "logging test"))))))
    (check (capture-contains capture "workspace operation.begin"))
    (check (capture-contains capture "workspace operation.applied"))))

(defun test-env-level-precedence ()
  "An explicit init-file level wins; otherwise the environment chain
applies and unknown values fail closed."
  (check (eq (quasar.log:resolve-log-level :warn) :warn))
  (check (eq (quasar.log:parse-log-level "warning") :warn))
  (check (eq (quasar.log:parse-log-level "FATAL") :fatal))
  (handler-case (quasar.log:parse-log-level "loud")
    (quasar.log:log-config-error () t)
    (:no-error (value) (declare (ignore value)) (check nil))))

(defun restore-default-logging ()
  (quasar.config:reset-config)
  (quasar.log:apply-config))

(defun run-logging-tests ()
  (test-default-config-selects-stdout)
  (test-init-override-selects-file-sink)
  (test-log-level-filtering)
  (test-structured-fields-text)
  (test-structured-fields-json)
  (test-error-and-fatal-logging)
  (test-concurrent-writes-are-line-complete)
  (test-restart-persistence)
  (test-flush-and-shutdown-behavior)
  (test-sink-failure-does-not-signal)
  (test-invalid-configuration-fails-closed)
  (test-event-vocabulary-compat)
  (test-workspace-operation-events)
  (test-env-level-precedence)
  (restore-default-logging)
  t)
