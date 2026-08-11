(in-package #:quasar.control-plane)

(defun parse-log-level (value)
  (let ((level (string-downcase (or value "debug"))))
    (cond
      ((string= level "debug") :debug)
      ((string= level "info") :info)
      ((member level '("warn" "warning") :test #'string=) :warn)
      ((string= level "error") :error)
      ((string= level "off") :off)
      (t :debug))))

(defun log-level-rank (level)
  (ecase level
    (:debug 10)
    (:info 20)
    (:warn 30)
    (:error 40)
    (:off 100)))

(defun configured-log-level ()
  ;; Local developer processes are intentionally verbose by default. CI is
  ;; quieter unless QUASAR_LOG_LEVEL=debug is explicitly requested.
  (parse-log-level
   (or (uiop:getenv "QUASAR_LOG_LEVEL")
       (and (uiop:getenv "CI") "info")
       "debug")))

(defun diagnostic-timestamp ()
  (multiple-value-bind (second minute hour day month year)
      (decode-universal-time (get-universal-time) 0)
    (format nil "~4,'0D-~2,'0D-~2,'0DT~2,'0D:~2,'0D:~2,'0DZ"
            year month day hour minute second)))

(defun diagnostic-log (level subsystem event &rest fields)
  (when (>= (log-level-rank level)
            (log-level-rank (configured-log-level)))
    (format *error-output* "~&[quasar] ~A ~A ~A ~A"
            (diagnostic-timestamp)
            (string-upcase (symbol-name level))
            subsystem
            event)
    (loop for (key value) on fields by #'cddr
          do (format *error-output* " ~A=~S" key value))
    (terpri *error-output*)
    (finish-output *error-output*)))

(defun safe-error-details (condition)
  (or (quasar.protocol:quasar-error-details condition)
      (quasar.protocol:empty-object)))

(in-package #:quasar.workspace)

(defun operation-diagnostic-context (operation index)
  (let* ((type (quasar.protocol:json-value operation "type"))
         (payload (or (quasar.protocol:json-value operation "payload")
                      (quasar.protocol:empty-object)))
         (nested-document (quasar.protocol:json-value payload "document"))
         (document-id
           (or (quasar.protocol:json-value payload "documentId")
               (quasar.protocol:json-value payload "_id")
               (and nested-document
                    (quasar.protocol:json-value nested-document "_id"))))
         (dtype
           (or (quasar.protocol:json-value payload "dtype")
               (and nested-document
                    (quasar.protocol:json-value nested-document "dtype"))))
         (id (quasar.protocol:json-value payload "id"))
         (graph-id (quasar.protocol:json-value payload "graphId")))
    (list :index index
          :type type
          :id id
          :document-id document-id
          :dtype dtype
          :graph-id graph-id)))

(defun operation-context-details (context cause)
  (quasar.protocol:json-object
   (cons "operationIndex" (getf context :index))
   (cons "operationType" (or (getf context :type) :null))
   (cons "id" (or (getf context :id) :null))
   (cons "documentId" (or (getf context :document-id) :null))
   (cons "dtype" (or (getf context :dtype) :null))
   (cons "graphId" (or (getf context :graph-id) :null))
   (cons "cause" (or cause (quasar.protocol:empty-object)))))

(defun commit-operations (workspace operations)
  "Apply every operation with per-operation diagnostics and enriched failures."
  (let ((applied-operations '())
        (inverses '()))
    (loop for operation in operations
          for index from 1
          for context = (operation-diagnostic-context operation index)
          do
             (quasar.control-plane::diagnostic-log
              :debug "workspace" "operation.begin"
              :workspace (workspace-id workspace)
              :revision (workspace-revision workspace)
              :index index
              :type (getf context :type)
              :id (getf context :id)
              :document-id (getf context :document-id)
              :dtype (getf context :dtype)
              :graph-id (getf context :graph-id))
             (handler-case
                 (let ((applied (dispatch-operation workspace operation)))
                   (push applied applied-operations)
                   (push (applied-op-inverse applied) inverses)
                   (quasar.control-plane::diagnostic-log
                    :debug "workspace" "operation.applied"
                    :workspace (workspace-id workspace)
                    :index index
                    :type (getf context :type)
                    :event (applied-op-event applied)))
               (quasar.protocol:quasar-error (condition)
                 (let ((cause
                         (or (quasar.protocol:quasar-error-details condition)
                             (quasar.protocol:empty-object))))
                   (quasar.control-plane::diagnostic-log
                    :error "workspace" "operation.failed"
                    :workspace (workspace-id workspace)
                    :index index
                    :type (getf context :type)
                    :id (getf context :id)
                    :document-id (getf context :document-id)
                    :dtype (getf context :dtype)
                    :graph-id (getf context :graph-id)
                    :code (quasar.protocol:quasar-error-code condition)
                    :message (quasar.protocol:quasar-error-message condition)
                    :details cause)
                   (error 'quasar.protocol:quasar-error
                          :code (quasar.protocol:quasar-error-code condition)
                          :message (quasar.protocol:quasar-error-message condition)
                          :details (operation-context-details context cause))))))
    (values (nreverse applied-operations) (nreverse inverses))))

(in-package #:quasar.control-plane)

(defun dispatch-message (plane message)
  ;; Loaded after Melissa's async-control-plane extension, so this preserves
  ;; async dispatch while making every command/error visible in debug output.
  (destructuring-bind (&key envelope reply) message
    (let* ((id (quasar.protocol:command-envelope-id envelope))
           (command (quasar.protocol:command-envelope-command envelope))
           (payload (quasar.protocol:command-envelope-payload envelope))
           (handler (gethash command (control-plane-handlers plane)))
           (async-table (gethash plane *async-handler-tables*))
           (async-handler (and async-table (gethash command async-table)))
           (workspace (or (quasar.protocol:command-envelope-workspace envelope) "default"))
           (client (or (quasar.protocol:command-envelope-client envelope) "unknown")))
      (diagnostic-log :debug "control-plane" "command.received"
                      :request-id id
                      :command command
                      :workspace workspace
                      :client client
                      :async (if async-handler t nil))
      (handler-case
          (cond
            (async-handler
             (diagnostic-log :debug "control-plane" "command.async-dispatch"
                             :request-id id :command command :workspace workspace)
             (funcall async-handler id payload envelope reply))
            (handler
             (let ((result (funcall handler payload envelope)))
               (diagnostic-log :debug "control-plane" "command.ok"
                               :request-id id :command command :workspace workspace)
               (funcall reply (quasar.protocol:encode-result id result))))
            (t
             (diagnostic-log :warn "control-plane" "command.unknown"
                             :request-id id :command command :workspace workspace)
             (funcall reply
                      (quasar.protocol:encode-error
                       id "protocol.unknown-command"
                       (format nil "Unknown command ~A." command)
                       (quasar.protocol:empty-object)))))
        (quasar.protocol:quasar-error (condition)
          (diagnostic-log :error "control-plane" "command.failed"
                          :request-id id
                          :command command
                          :workspace workspace
                          :code (quasar.protocol:quasar-error-code condition)
                          :message (quasar.protocol:quasar-error-message condition)
                          :details (safe-error-details condition))
          (funcall reply (quasar.protocol:quasar-error-to-envelope id condition)))
        (error (condition)
          (diagnostic-log :error "control-plane" "command.crashed"
                          :request-id id
                          :command command
                          :workspace workspace
                          :condition (princ-to-string condition))
          (funcall reply
                   (quasar.protocol:encode-error
                    id "control-plane.unavailable"
                    "The control plane could not process the command."
                    (quasar.protocol:empty-object))))))))
