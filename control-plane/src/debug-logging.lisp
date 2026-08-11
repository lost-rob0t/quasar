(in-package #:quasar.control-plane)

(defun parse-log-level (value)
  (let ((level (string-downcase (or value "debug"))))
    (cond
      ((string= level "debug") :debug)
      ((string= level "info") :info)
      ((string= level "warn") :warn)
      ((string= level "warning") :warn)
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
  ;; Developer processes are intentionally noisy by default. CI stays at INFO
  ;; unless QUASAR_LOG_LEVEL explicitly asks for DEBUG.
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

(defun envelope-workspace-id (envelope)
  (or (quasar.protocol:command-envelope-workspace envelope) "default"))

(defun condition-details-for-log (condition)
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

(defun operation-context-details (context &optional cause)
  (quasar.protocol:json-object
   (cons "operationIndex" (getf context :index))
   (cons "operationType" (or (getf context :type) :null))
   (cons "id" (or (getf context :id) :null))
   (cons "documentId" (or (getf context :document-id) :null))
   (cons "dtype" (or (getf context :dtype) :null))
   (cons "graphId" (or (getf context :graph-id) :null))
   (cons "cause" (or cause (quasar.protocol:empty-object)))))

(defun commit-operations (workspace operations)
  "Apply every operation and attach the failing operation context to errors.
WORKSPACE is expected to be an isolated candidate copy owned by the caller."
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
                          :details (operation-context-details context cause))))
               (error (condition)
                 (quasar.control-plane::diagnostic-log
                  :error "workspace" "operation.crashed"
                  :workspace (workspace-id workspace)
                  :index index
                  :type (getf context :type)
                  :id (getf context :id)
                  :document-id (getf context :document-id)
                  :dtype (getf context :dtype)
                  :graph-id (getf context :graph-id)
                  :condition (princ-to-string condition))
                 (error 'quasar.protocol:quasar-error
                        :code "operation.internal-error"
                        :message (format nil "Unexpected failure applying operation ~D (~A)."
                                         index (or (getf context :type) "unknown"))
                        :details (operation-context-details context))))
    (values (nreverse applied-operations) (nreverse inverses))))

(in-package #:quasar.control-plane)

(defun run-operation (plane envelope operation)
  "Apply and persist one operation with structured developer diagnostics."
  (let* ((workspace (workspace-for plane envelope))
         (base-revision (quasar.workspace:workspace-revision workspace))
         (type (quasar.protocol:json-value operation "type"))
         (payload (or (quasar.protocol:json-value operation "payload")
                      (quasar.protocol:empty-object)))
         (document-id (or (quasar.protocol:json-value payload "documentId")
                          (quasar.protocol:json-value payload "_id")))
         (graph-id (quasar.protocol:json-value payload "graphId")))
    (diagnostic-log :debug "control-plane" "operation.begin"
                    :request-id (quasar.protocol:command-envelope-id envelope)
                    :workspace (quasar.workspace:workspace-id workspace)
                    :revision base-revision
                    :type type
                    :document-id document-id
                    :graph-id graph-id
                    :client (quasar.protocol:command-envelope-client envelope))
    (handler-case
        (let* ((candidate (quasar.workspace:copy-workspace workspace))
               (applied (quasar.workspace:dispatch-operation candidate operation))
               (operation-id (next-operation-id)))
          (incf (quasar.workspace:workspace-revision candidate))
          (let ((result-obj (applied-op-result applied)))
            (quasar.protocol:object-set result-obj "operationId" operation-id)
            (quasar.protocol:object-set result-obj "revision"
                                        (quasar.workspace:workspace-revision candidate))
            (quasar.protocol:object-set result-obj "event" (applied-op-event applied)))
          (diagnostic-log :debug "control-plane" "operation.persist"
                          :operation-id operation-id
                          :workspace (quasar.workspace:workspace-id candidate)
                          :base-revision base-revision
                          :revision (quasar.workspace:workspace-revision candidate)
                          :type type)
          (quasar.store:commit-workspace
           (control-plane-store plane) candidate
           (quasar.protocol:json-object
            (cons "operationId" operation-id)
            (cons "workspaceId" (quasar.workspace:workspace-id candidate))
            (cons "baseRevision" base-revision)
            (cons "committedRevision" (quasar.workspace:workspace-revision candidate))
            (cons "command" (quasar.protocol:clone-json operation))
            (cons "result" (quasar.protocol:clone-json (applied-op-result applied)))
            (cons "timestamp" (get-universal-time))
            (cons "client" (or (quasar.protocol:command-envelope-client envelope) "unknown"))))
          (setf (gethash (quasar.workspace:workspace-id candidate)
                         (control-plane-workspaces plane))
                candidate)
          (broadcast-event plane
                           (applied-op-event applied)
                           (quasar.workspace:workspace-id candidate)
                           (quasar.workspace:workspace-revision candidate)
                           operation-id
                           (applied-op-result applied))
          (diagnostic-log :info "control-plane" "operation.committed"
                          :operation-id operation-id
                          :workspace (quasar.workspace:workspace-id candidate)
                          :revision (quasar.workspace:workspace-revision candidate)
                          :type type
                          :event (applied-op-event applied))
          (applied-op-result applied))
      (quasar.protocol:quasar-error (condition)
        (diagnostic-log :error "control-plane" "operation.failed"
                        :request-id (quasar.protocol:command-envelope-id envelope)
                        :workspace (quasar.workspace:workspace-id workspace)
                        :type type
                        :document-id document-id
                        :graph-id graph-id
                        :code (quasar.protocol:quasar-error-code condition)
                        :message (quasar.protocol:quasar-error-message condition)
                        :details (condition-details-for-log condition))
        (error condition))
      (error (condition)
        (diagnostic-log :error "control-plane" "operation.crashed"
                        :request-id (quasar.protocol:command-envelope-id envelope)
                        :workspace (quasar.workspace:workspace-id workspace)
                        :type type
                        :document-id document-id
                        :graph-id graph-id
                        :condition (princ-to-string condition))
        (error condition)))))

(defun handle-transaction (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (operations (quasar.protocol:ensure-array
                      (quasar.protocol:json-value payload "operations")
                      "operations" "protocol.invalid-envelope"))
         (operation-list (array-elements operations))
         (expected-revision (quasar.protocol:json-value payload "expectedRevision")))
    (when (null operation-list)
      (error 'quasar.protocol:quasar-error
             :code "transaction.failed"
             :message "A transaction must contain at least one operation."))
    (when (and expected-revision
               (/= expected-revision (quasar.workspace:workspace-revision workspace)))
      (diagnostic-log :warn "transaction" "revision-conflict"
                      :request-id (quasar.protocol:command-envelope-id envelope)
                      :workspace (quasar.workspace:workspace-id workspace)
                      :expected expected-revision
                      :current (quasar.workspace:workspace-revision workspace))
      (error 'quasar.protocol:quasar-error
             :code "workspace.revision-conflict"
             :message (format nil "Expected revision ~A but current is ~A."
                              expected-revision
                              (quasar.workspace:workspace-revision workspace))))
    (let* ((candidate (quasar.workspace:copy-workspace workspace))
           (base-revision (quasar.workspace:workspace-revision workspace))
           (transaction-id (next-transaction-id)))
      (diagnostic-log :debug "transaction" "begin"
                      :transaction-id transaction-id
                      :request-id (quasar.protocol:command-envelope-id envelope)
                      :workspace (quasar.workspace:workspace-id workspace)
                      :base-revision base-revision
                      :expected-revision expected-revision
                      :operation-count (length operation-list)
                      :client (quasar.protocol:command-envelope-client envelope))
      (let ((applied-operations
              (handler-case
                  (multiple-value-bind (applied inverses)
                      (quasar.workspace:commit-operations candidate operation-list)
                    (declare (ignore inverses))
                    applied)
                (quasar.protocol:quasar-error (condition)
                  (let ((details (condition-details-for-log condition)))
                    (diagnostic-log :error "transaction" "rollback"
                                    :transaction-id transaction-id
                                    :request-id (quasar.protocol:command-envelope-id envelope)
                                    :workspace (quasar.workspace:workspace-id workspace)
                                    :base-revision base-revision
                                    :code (quasar.protocol:quasar-error-code condition)
                                    :message (quasar.protocol:quasar-error-message condition)
                                    :details details)
                    (error 'quasar.protocol:quasar-error
                           :code "transaction.failed"
                           :message "One or more operations failed; the transaction was rolled back."
                           :details (quasar.protocol:json-object
                                     (cons "code" (quasar.protocol:quasar-error-code condition))
                                     (cons "message" (quasar.protocol:quasar-error-message condition))
                                     (cons "details" details))))))))
        (let* ((revision (incf (quasar.workspace:workspace-revision candidate)))
               (event-count (length applied-operations))
               (results
                 (loop for applied in applied-operations
                       for n from 1
                       for operation-id = (format nil "~A:~D" transaction-id n)
                       collect (let ((result (applied-op-result applied)))
                                 (quasar.protocol:object-set result "operationId" operation-id)
                                 (quasar.protocol:object-set result "transactionId" transaction-id)
                                 (quasar.protocol:object-set result "eventIndex" n)
                                 (quasar.protocol:object-set result "eventCount" event-count)
                                 (quasar.protocol:object-set result "revision" revision)
                                 (quasar.protocol:object-set result "event"
                                                             (applied-op-event applied))
                                 result))))
          (diagnostic-log :debug "transaction" "persist"
                          :transaction-id transaction-id
                          :workspace (quasar.workspace:workspace-id candidate)
                          :base-revision base-revision
                          :revision revision
                          :operation-count event-count)
          (quasar.store:commit-workspace
           (control-plane-store plane) candidate
           (quasar.protocol:json-object
            (cons "transactionId" transaction-id)
            (cons "workspaceId" (quasar.workspace:workspace-id candidate))
            (cons "baseRevision" base-revision)
            (cons "committedRevision" revision)
            (cons "commands" (quasar.protocol:clone-json operations))
            (cons "timestamp" (get-universal-time))
            (cons "client" (or (quasar.protocol:command-envelope-client envelope)
                                "unknown"))))
          (setf (gethash (quasar.workspace:workspace-id candidate)
                         (control-plane-workspaces plane))
                candidate)
          (loop for applied in applied-operations
                for result in results
                for n from 1
                do (broadcast-event plane
                                    (applied-op-event applied)
                                    (quasar.workspace:workspace-id candidate)
                                    revision
                                    (quasar.protocol:json-value result "operationId")
                                    result
                                    :transaction-id transaction-id
                                    :event-index n
                                    :event-count event-count))
          (diagnostic-log :info "transaction" "committed"
                          :transaction-id transaction-id
                          :request-id (quasar.protocol:command-envelope-id envelope)
                          :workspace (quasar.workspace:workspace-id candidate)
                          :revision revision
                          :operation-count event-count)
          (quasar.protocol:json-object
           (cons "operationId" transaction-id)
           (cons "transactionId" transaction-id)
           (cons "revision" revision)
           (cons "workspaceId" (quasar.workspace:workspace-id candidate))
           (cons "results" (apply #'quasar.protocol:json-array results))))))))

(defun dispatch-message (plane message)
  ;; This definition intentionally comes after the Melissa async-control-plane
  ;; extension and preserves async command dispatch while adding diagnostics.
  (destructuring-bind (&key envelope reply) message
    (let* ((id (quasar.protocol:command-envelope-id envelope))
           (command (quasar.protocol:command-envelope-command envelope))
           (payload (quasar.protocol:command-envelope-payload envelope))
           (handler (gethash command (control-plane-handlers plane)))
           (async-table (gethash plane *async-handler-tables*))
           (async-handler (and async-table (gethash command async-table)))
           (workspace (envelope-workspace-id envelope))
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
                          :details (condition-details-for-log condition))
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
