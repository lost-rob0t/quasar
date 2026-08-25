(in-package #:quasar.control-plane)

(defun run-materialized-operation (plane envelope operation)
  "Compatibility mutation path for the non-streaming in-memory store."
  (let* ((workspace (workspace-for plane envelope))
         (base-revision (quasar.workspace:workspace-revision workspace))
         (candidate (quasar.workspace:copy-workspace workspace))
         (applied (quasar.workspace:dispatch-operation candidate operation))
         (operation-id (next-operation-id)))
    (incf (quasar.workspace:workspace-revision candidate))
    (let ((result-obj (applied-op-result applied)))
      (quasar.protocol:object-set result-obj "operationId" operation-id)
      (quasar.protocol:object-set
       result-obj "revision" (quasar.workspace:workspace-revision candidate))
      (quasar.protocol:object-set
       result-obj "event" (applied-op-event applied)))
    (quasar.store:commit-workspace
     (control-plane-store plane)
     candidate
     (quasar.protocol:json-object
      (cons "operationId" operation-id)
      (cons "workspaceId" (quasar.workspace:workspace-id candidate))
      (cons "baseRevision" base-revision)
      (cons "committedRevision"
            (quasar.workspace:workspace-revision candidate))
      (cons "command" (quasar.protocol:clone-json operation))
      (cons "result"
            (quasar.protocol:clone-json (applied-op-result applied)))
      (cons "timestamp" (get-universal-time))
      (cons "client"
            (or
             (quasar.protocol:command-envelope-client envelope)
             "unknown"))))
    (setf
     (gethash
      (quasar.workspace:workspace-id candidate)
      (control-plane-workspaces plane))
     candidate)
    (broadcast-event
     plane
     (applied-op-event applied)
     (quasar.workspace:workspace-id candidate)
     (quasar.workspace:workspace-revision candidate)
     operation-id
     (applied-op-result applied))
    (applied-op-result applied)))

(defun run-operation (plane envelope operation)
  "Run one authoritative mutation using the store-appropriate isolation model."
  (if (quasar.store:streaming-store-p (control-plane-store plane))
      (run-record-operation plane envelope operation)
      (run-materialized-operation plane envelope operation)))

(defun handle-operation (plane payload envelope type-name)
  (run-operation
   plane
   envelope
   (quasar.protocol:json-object
    (cons "type" type-name)
    (cons "payload" payload))))

(defun handle-materialized-transaction (plane payload envelope)
  "Compatibility transaction path for the non-streaming in-memory store."
  (let* ((workspace (workspace-for plane envelope))
         (operations
           (quasar.protocol:ensure-array
            (quasar.protocol:json-value payload "operations")
            "operations"
            "protocol.invalid-envelope"))
         (expected-revision
           (quasar.protocol:json-value payload "expectedRevision")))
    (when (null (array-elements operations))
      (error 'quasar.protocol:quasar-error
             :code "transaction.failed"
             :message "A transaction must contain at least one operation."))
    (when
        (and expected-revision
             (/= expected-revision
                 (quasar.workspace:workspace-revision workspace)))
      (error 'quasar.protocol:quasar-error
             :code "workspace.revision-conflict"
             :message
             (format nil
                     "Expected revision ~A but current is ~A."
                     expected-revision
                     (quasar.workspace:workspace-revision workspace))))
    (let* ((candidate (quasar.workspace:copy-workspace workspace))
           (base-revision (quasar.workspace:workspace-revision workspace))
           (transaction-id (next-transaction-id))
           (applied-operations
             (handler-case
                 (multiple-value-bind (applied inverses)
                     (quasar.workspace:commit-operations
                      candidate (array-elements operations))
                   (declare (ignore inverses))
                   applied)
               (quasar.protocol:quasar-error (condition)
                 (error 'quasar.protocol:quasar-error
                        :code "transaction.failed"
                        :message
                        "One or more operations failed; the transaction was rolled back."
                        :details
                        (quasar.protocol:json-object
                         (cons
                          "code"
                          (quasar.protocol:quasar-error-code condition))
                         (cons
                          "message"
                          (quasar.protocol:quasar-error-message condition))
                         (cons
                          "details"
                          (quasar.protocol:quasar-error-details condition))))))))
      (let* ((revision
               (incf (quasar.workspace:workspace-revision candidate)))
             (event-count (length applied-operations))
             (results
               (loop for applied in applied-operations
                     for n from 1
                     for operation-id = (format nil "~A:~D" transaction-id n)
                     collect
                       (let ((result (applied-op-result applied)))
                         (quasar.protocol:object-set
                          result "operationId" operation-id)
                         (quasar.protocol:object-set
                          result "transactionId" transaction-id)
                         (quasar.protocol:object-set result "eventIndex" n)
                         (quasar.protocol:object-set
                          result "eventCount" event-count)
                         (quasar.protocol:object-set
                          result "revision" revision)
                         (quasar.protocol:object-set
                          result "event" (applied-op-event applied))
                         result))))
        (quasar.store:commit-workspace
         (control-plane-store plane)
         candidate
         (quasar.protocol:json-object
          (cons "transactionId" transaction-id)
          (cons "workspaceId" (quasar.workspace:workspace-id candidate))
          (cons "baseRevision" base-revision)
          (cons "committedRevision" revision)
          (cons "commands" (quasar.protocol:clone-json operations))
          (cons "timestamp" (get-universal-time))
          (cons "client"
                (or
                 (quasar.protocol:command-envelope-client envelope)
                 "unknown"))))
        (setf
         (gethash
          (quasar.workspace:workspace-id candidate)
          (control-plane-workspaces plane))
         candidate)
        (loop for applied in applied-operations
              for result in results
              for n from 1
              do
                (broadcast-event
                 plane
                 (applied-op-event applied)
                 (quasar.workspace:workspace-id candidate)
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
         (cons "workspaceId" (quasar.workspace:workspace-id candidate))
         (cons "results" (apply #'quasar.protocol:json-array results)))))))

(defun handle-transaction (plane payload envelope)
  "Run an ordered transaction with one durable commit and one revision advance."
  (if (quasar.store:streaming-store-p (control-plane-store plane))
      (handle-record-transaction plane payload envelope)
      (handle-materialized-transaction plane payload envelope)))
