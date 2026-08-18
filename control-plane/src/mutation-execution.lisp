(in-package #:quasar.control-plane)

(defun mutation-journal-entry
    (envelope workspace-id operation-id base-revision committed-revision operation result)
  (quasar.protocol:json-object
   (cons "operationId" operation-id)
   (cons "workspaceId" workspace-id)
   (cons "baseRevision" base-revision)
   (cons "committedRevision" committed-revision)
   (cons "command" (quasar.protocol:clone-json operation))
   (cons "result" (quasar.protocol:clone-json result))
   (cons "timestamp" (get-universal-time))
   (cons "client"
         (or (quasar.protocol:command-envelope-client envelope) "unknown"))))

(defun transaction-journal-entry
    (envelope workspace-id transaction-id base-revision committed-revision operations)
  (quasar.protocol:json-object
   (cons "transactionId" transaction-id)
   (cons "workspaceId" workspace-id)
   (cons "baseRevision" base-revision)
   (cons "committedRevision" committed-revision)
   (cons "commands" (quasar.protocol:clone-json operations))
   (cons "timestamp" (get-universal-time))
   (cons "client"
         (or (quasar.protocol:command-envelope-client envelope) "unknown"))))

(defun run-record-operation (plane envelope operation)
  (let* ((store (control-plane-store plane))
         (workspace-id
           (or (quasar.protocol:command-envelope-workspace envelope) "default"))
         (context (make-record-mutation-context store workspace-id))
         (workspace (mutation-context-workspace context))
         (base-revision (mutation-context-base-revision context))
         (applied (mutation-context-apply-operation context operation))
         (operation-id (next-operation-id))
         (revision (1+ base-revision))
         (result (applied-op-result applied)))
    (setf (quasar.workspace:workspace-revision workspace) revision)
    (quasar.protocol:object-set result "operationId" operation-id)
    (quasar.protocol:object-set result "revision" revision)
    (quasar.protocol:object-set result "event" (applied-op-event applied))
    (quasar.store:commit-change-set
     store
     workspace-id
     base-revision
     revision
     (mutation-context-settings-json context)
     (quasar.workspace:workspace-persistence-changes workspace)
     (mutation-journal-entry
      envelope workspace-id operation-id base-revision revision operation result))
    ;; A full compatibility cache may predate Phase 3. It is never authoritative
    ;; for Tek9 mutations and must not survive a successful durable commit.
    (remhash workspace-id (control-plane-workspaces plane))
    (broadcast-event
     plane
     (applied-op-event applied)
     workspace-id
     revision
     operation-id
     result)
    result))

(defun validate-record-transaction-request (operations expected-revision base-revision)
  (let ((items (array-elements operations)))
    (when (null items)
      (error 'quasar.protocol:quasar-error
             :code "transaction.failed"
             :message "A transaction must contain at least one operation."))
    (when (> (length items) +mutation-max-operations+)
      (error 'quasar.protocol:quasar-error
             :code "transaction.too-large"
             :message
             (format nil
                     "A transaction may contain at most ~D operations."
                     +mutation-max-operations+)))
    (when (and expected-revision (/= expected-revision base-revision))
      (error 'quasar.protocol:quasar-error
             :code "workspace.revision-conflict"
             :message
             (format nil
                     "Expected revision ~A but current is ~A."
                     expected-revision base-revision)))
    items))

(defun apply-record-transaction-operations (context operations)
  (handler-case
      (loop
        for operation in operations
        collect (mutation-context-apply-operation context operation))
    (quasar.protocol:quasar-error (condition)
      (error 'quasar.protocol:quasar-error
             :code "transaction.failed"
             :message
             "One or more operations failed; the transaction was rolled back."
             :details
             (quasar.protocol:json-object
              (cons "code" (quasar.protocol:quasar-error-code condition))
              (cons "message" (quasar.protocol:quasar-error-message condition))
              (cons "details" (quasar.protocol:quasar-error-details condition)))))))

(defun record-transaction-results
    (applied-operations transaction-id revision)
  (let ((event-count (length applied-operations)))
    (loop
      for applied in applied-operations
      for n from 1
      for operation-id = (format nil "~A:~D" transaction-id n)
      collect
        (let ((result (applied-op-result applied)))
          (quasar.protocol:object-set result "operationId" operation-id)
          (quasar.protocol:object-set result "transactionId" transaction-id)
          (quasar.protocol:object-set result "eventIndex" n)
          (quasar.protocol:object-set result "eventCount" event-count)
          (quasar.protocol:object-set result "revision" revision)
          (quasar.protocol:object-set result "event" (applied-op-event applied))
          result))))

(defun handle-record-transaction (plane payload envelope)
  (let* ((store (control-plane-store plane))
         (workspace-id
           (or (quasar.protocol:command-envelope-workspace envelope) "default"))
         (operations
           (quasar.protocol:ensure-array
            (quasar.protocol:json-value payload "operations")
            "operations"
            "protocol.invalid-envelope"))
         (expected-revision
           (quasar.protocol:json-value payload "expectedRevision"))
         (context (make-record-mutation-context store workspace-id))
         (base-revision (mutation-context-base-revision context))
         (items
           (validate-record-transaction-request
            operations expected-revision base-revision))
         (applied-operations
           (apply-record-transaction-operations context items))
         (workspace (mutation-context-workspace context))
         (transaction-id (next-transaction-id))
         (revision (1+ base-revision))
         (results
           (record-transaction-results
            applied-operations transaction-id revision))
         (event-count (length applied-operations)))
    (setf (quasar.workspace:workspace-revision workspace) revision)
    (quasar.store:commit-change-set
     store
     workspace-id
     base-revision
     revision
     (mutation-context-settings-json context)
     (quasar.workspace:workspace-persistence-changes workspace)
     (transaction-journal-entry
      envelope
      workspace-id
      transaction-id
      base-revision
      revision
      operations))
    (remhash workspace-id (control-plane-workspaces plane))
    (loop
      for applied in applied-operations
      for result in results
      for n from 1
      do
        (broadcast-event
         plane
         (applied-op-event applied)
         workspace-id
         revision
         (quasar.protocol:json-value result "operationId")
         result
         :transaction-id transaction-id
         :event-index n
         :event-count event-count))
    (quasar.protocol:json-object
     (cons "operationId" transaction-id)
     (cons "transactionId" transaction-id)
     (cons "revision" revision)
     (cons "workspaceId" workspace-id)
     (cons "results" (apply #'quasar.protocol:json-array results)))))
