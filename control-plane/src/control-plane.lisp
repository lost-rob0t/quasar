(in-package #:quasar.control-plane)

(defclass control-plane ()
  ((actor-system :initform nil :accessor control-plane-actor-system)
   (command-actor :initform nil :accessor control-plane-command-actor)
   (handlers :initform (make-hash-table :test #'equal)
             :reader control-plane-handlers)
   (workspaces :initform (make-hash-table :test #'equal)
               :reader control-plane-workspaces)
   (store :initarg :store :initform (quasar.store:make-memory-store)
          :reader control-plane-store)
   (subscribers :initform (make-hash-table :test #'equal)
                :reader control-plane-subscribers)
   (import-sessions :initform (make-hash-table :test #'equal)
                    :reader control-plane-import-sessions)
   (started-p :initform nil :accessor control-plane-started-p)
   (lock :initform (bt:make-lock) :reader control-plane-lock))
  (:documentation
   "The control plane owns canonical workspace state. All mutations pass
through a single-writer actor. The plane never leaks Lisp conditions to
clients."))

(defun make-control-plane (&key (store (quasar.store:make-memory-store)))
  (make-instance 'control-plane :store store))

(defun register-command (plane name handler)
  (check-type name string)
  (check-type handler function)
  (setf (gethash name (control-plane-handlers plane)) handler)
  name)

(defun control-plane-capabilities (plane)
  (sort (loop for name being the hash-keys of (control-plane-handlers plane)
              collect name)
        #'string<))

(defun workspace-for (plane envelope)
  "Return the workspace for the envelope's workspace ID.
Loads from the store if not already in memory; creates a new workspace if
the store has no record."
  (let* ((workspace-id (or (quasar.protocol:command-envelope-workspace envelope)
                           "default"))
         (workspace (gethash workspace-id (control-plane-workspaces plane))))
    (unless workspace
      (let ((loaded (quasar.store:load-workspace
                     (control-plane-store plane) workspace-id)))
        (setf workspace (or loaded (quasar.workspace:make-workspace :id workspace-id))
              (gethash workspace-id (control-plane-workspaces plane)) workspace)))
    workspace))

(defun subscribe (plane handler)
  (let ((id (format nil "sub-~36R" (random most-positive-fixnum))))
    (setf (gethash id (control-plane-subscribers plane)) handler)
    id))

(defun unsubscribe (plane id)
  (remhash id (control-plane-subscribers plane)))

(defun broadcast-event (plane event workspace-id revision operation-id payload
                        &key transaction-id event-index event-count)
  (let ((encoded (quasar.protocol:encode-event
                  event workspace-id revision operation-id payload
                  :transaction-id transaction-id :event-index event-index
                  :event-count event-count)))
    (loop for handler being the hash-values of (control-plane-subscribers plane)
          do (handler-case
                 (funcall handler encoded)
               (error (condition)
                 (format *error-output* "~&[control-plane] subscriber failed: ~A~%"
                         condition))))))

(defun next-operation-id ()
  (format nil "op-~36R-~36R" (get-universal-time) (random most-positive-fixnum)))

(defun next-transaction-id ()
  (format nil "txn-~36R-~36R" (get-universal-time) (random most-positive-fixnum)))

(defstruct import-session
  workspace
  workspace-id
  base-revision
  (document-count 0)
  (encoded-chunks (make-array 0 :adjustable t :fill-pointer 0)))

(defun import-session-for (plane payload envelope)
  (let* ((id (quasar.protocol:ensure-string
              (quasar.protocol:json-value payload "sessionId")
              "sessionId" "import.invalid-session"))
         (session (gethash id (control-plane-import-sessions plane)))
         (workspace-id (or (quasar.protocol:command-envelope-workspace envelope)
                           "default")))
    (unless (and session (string= workspace-id (import-session-workspace-id session)))
      (error 'quasar.protocol:quasar-error
             :code "import.invalid-session"
             :message "The document import session does not exist."))
    (values session id)))

(defun handle-import-begin (plane payload envelope)
  (declare (ignore payload))
  (let* ((workspace (workspace-for plane envelope))
         (workspace-id (quasar.workspace:workspace-id workspace)))
    (loop for session being the hash-values of (control-plane-import-sessions plane)
          unless (string= workspace-id (import-session-workspace-id session))
            do (error 'quasar.protocol:quasar-error
                      :code "import.busy"
                      :message "Another workspace is already importing documents."))
    (clrhash (control-plane-import-sessions plane))
    (let* ((id (next-transaction-id))
           (session (make-import-session
                     :workspace (quasar.workspace:copy-workspace workspace)
                     :workspace-id workspace-id
                     :base-revision (quasar.workspace:workspace-revision workspace))))
      (setf (gethash id (control-plane-import-sessions plane)) session)
      (quasar.protocol:json-object
       (cons "sessionId" id)
       (cons "baseRevision" (import-session-base-revision session))))))

(defun handle-import-chunk (plane payload envelope)
  (multiple-value-bind (session id) (import-session-for plane payload envelope)
    (let ((operations (quasar.protocol:ensure-array
                       (quasar.protocol:json-value payload "operations")
                       "operations" "protocol.invalid-envelope")))
      (handler-case
          (progn
            (dolist (operation (array-elements operations))
              (let ((type (quasar.protocol:json-value operation "type")))
                (unless (member type '("document.create" "document.update") :test #'string=)
                  (error 'quasar.protocol:quasar-error
                         :code "import.invalid-operation"
                         :message "Import chunks may only create or update documents."))
                (quasar.workspace:dispatch-operation
                 (import-session-workspace session) operation)))
            (vector-push-extend (quasar.protocol:encode operations)
                                (import-session-encoded-chunks session))
            (incf (import-session-document-count session)
                  (length (array-elements operations)))
            (quasar.protocol:json-object
             (cons "sessionId" id)
             (cons "documentCount" (import-session-document-count session))))
        (error (condition)
          (remhash id (control-plane-import-sessions plane))
          (error condition))))))

(defun handle-import-abort (plane payload envelope)
  (multiple-value-bind (session id) (import-session-for plane payload envelope)
    (declare (ignore session))
    (remhash id (control-plane-import-sessions plane))
    (quasar.protocol:json-object (cons "sessionId" id) (cons "aborted" t))))

(defun handle-import-commit (plane payload envelope)
  (multiple-value-bind (session id) (import-session-for plane payload envelope)
    (let* ((current (workspace-for plane envelope))
           (candidate (import-session-workspace session))
           (base-revision (import-session-base-revision session)))
      (unless (= base-revision (quasar.workspace:workspace-revision current))
        (remhash id (control-plane-import-sessions plane))
        (error 'quasar.protocol:quasar-error
               :code "workspace.revision-conflict"
               :message "The workspace changed during document import."))
      (let* ((revision (setf (quasar.workspace:workspace-revision candidate)
                             (1+ base-revision)))
             (operation-id (next-operation-id))
             (result (quasar.protocol:json-object
                      (cons "operationId" operation-id)
                      (cons "revision" revision)
                      (cons "workspaceId" (import-session-workspace-id session))
                      (cons "documentCount" (import-session-document-count session)))))
        (quasar.store:commit-workspace
         (control-plane-store plane) candidate
         (quasar.protocol:json-object
          (cons "operationId" operation-id)
          (cons "workspaceId" (import-session-workspace-id session))
          (cons "baseRevision" base-revision)
          (cons "committedRevision" revision)
          (cons "command" "document.import")
          (cons "encodedChunks"
                (cons :array (coerce (import-session-encoded-chunks session) 'list)))
          (cons "timestamp" (get-universal-time))
          (cons "client" (or (quasar.protocol:command-envelope-client envelope) "unknown"))))
        (setf (gethash (import-session-workspace-id session)
                       (control-plane-workspaces plane))
              candidate)
        (remhash id (control-plane-import-sessions plane))
        (broadcast-event plane "documents.imported"
                         (import-session-workspace-id session) revision operation-id result)
        result))))

;;; --- Command handlers ---

(defun handle-document-list (plane payload envelope)
  (declare (ignore payload))
  (let* ((workspace (workspace-for plane envelope))
         (documents (loop for document being the hash-values
                            of (quasar.workspace:workspace-documents workspace)
                          collect (quasar.protocol:clone-json document))))
    (apply #'quasar.protocol:json-array documents)))

(defun handle-document-get (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (id (quasar.protocol:ensure-string
              (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (let ((document (gethash id (quasar.workspace:workspace-documents workspace))))
      (unless document
        (error 'quasar.protocol:quasar-error
               :code "document.not-found"
               :message (format nil "Document ~A does not exist." id)))
      (quasar.protocol:clone-json document))))

(defun run-operation (plane envelope operation)
  "Apply a single operation to the authoritative workspace.
Saves to the store, journals the operation, broadcasts the event, and
returns a result envelope with revision, operation ID, and canonical data."
  (let* ((workspace (workspace-for plane envelope))
         (base-revision (quasar.workspace:workspace-revision workspace))
         (candidate (quasar.workspace:copy-workspace workspace))
         (applied (quasar.workspace:dispatch-operation candidate operation))
         (operation-id (next-operation-id)))
    (incf (quasar.workspace:workspace-revision candidate))
    (let ((result-obj (applied-op-result applied)))
      (quasar.protocol:object-set result-obj "operationId" operation-id)
      (quasar.protocol:object-set result-obj "revision"
                                  (quasar.workspace:workspace-revision candidate))
      (quasar.protocol:object-set result-obj "event" (applied-op-event applied)))
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
    (applied-op-result applied)))

(defun handle-operation (plane payload envelope type-name)
  (run-operation plane envelope
                 (quasar.protocol:json-object
                  (cons "type" type-name)
                  (cons "payload" payload))))

(defun array-elements (value)
  "Return the elements of a JSON array, handling both :array-tagged
  (our convention) and plain-list (JSOWN parsed) representations."
  (if (and (consp value) (eq (car value) :array))
      (rest value)
      value))

(defun handle-transaction (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (operations (quasar.protocol:ensure-array
                       (quasar.protocol:json-value payload "operations")
                       "operations" "protocol.invalid-envelope"))
         (expected-revision (quasar.protocol:json-value payload "expectedRevision")))
    (when (null (array-elements operations))
      (error 'quasar.protocol:quasar-error
             :code "transaction.failed"
             :message "A transaction must contain at least one operation."))
    (when (and expected-revision
               (/= expected-revision (quasar.workspace:workspace-revision workspace)))
      (error 'quasar.protocol:quasar-error
             :code "workspace.revision-conflict"
             :message (format nil "Expected revision ~A but current is ~A."
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
                        :message "One or more operations failed; the transaction was rolled back."
                        :details (quasar.protocol:json-object
                                  (cons "code" (quasar.protocol:quasar-error-code condition))
                                  (cons "message" (quasar.protocol:quasar-error-message condition))
                                  (cons "details" (quasar.protocol:quasar-error-details condition))))))))
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
        (quasar.protocol:json-object
         (cons "operationId" transaction-id)
         (cons "transactionId" transaction-id)
         (cons "revision" revision)
         (cons "workspaceId" (quasar.workspace:workspace-id candidate))
         (cons "results" (apply #'quasar.protocol:json-array results)))))))

(defun handle-snapshot (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (offset (quasar.protocol:json-value payload "documentOffset"))
         (requested-limit (quasar.protocol:json-value payload "documentByteLimit")))
    (if (or offset requested-limit)
        (progn
          (unless (and (integerp offset) (not (minusp offset)))
            (error 'quasar.protocol:quasar-error
                   :code "protocol.invalid-envelope"
                   :message "documentOffset must be a non-negative integer."))
          (unless (and (integerp requested-limit) (plusp requested-limit))
            (error 'quasar.protocol:quasar-error
                   :code "protocol.invalid-envelope"
                   :message "documentByteLimit must be a positive integer."))
          (quasar.workspace:workspace-snapshot-page
           workspace offset (min requested-limit (* 512 1024))))
        (quasar.workspace:workspace-snapshot workspace))))

(defun handle-graph-snapshot (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (graph-id (or (quasar.protocol:json-value payload "graphId") "default")))
    (quasar.workspace:graph-snapshot workspace graph-id)))

(defun install-core-commands (plane)
  (register-command
   plane "system.capabilities"
   (lambda (payload envelope)
     (declare (ignore payload envelope))
     (apply #'quasar.protocol:json-array (control-plane-capabilities plane))))
  (register-command plane "workspace.snapshot"
   (lambda (payload envelope)
     (handle-snapshot plane payload envelope)))
  (register-command plane "workspace.transaction"
   (lambda (payload envelope)
     (handle-transaction plane payload envelope)))
  (register-command plane "document.import.begin"
   (lambda (payload envelope) (handle-import-begin plane payload envelope)))
  (register-command plane "document.import.chunk"
   (lambda (payload envelope) (handle-import-chunk plane payload envelope)))
  (register-command plane "document.import.commit"
   (lambda (payload envelope) (handle-import-commit plane payload envelope)))
  (register-command plane "document.import.abort"
   (lambda (payload envelope) (handle-import-abort plane payload envelope)))
  (register-command plane "document.list"
   (lambda (payload envelope)
     (handle-document-list plane payload envelope)))
  (register-command plane "document.get"
   (lambda (payload envelope)
     (handle-document-get plane payload envelope)))
  (register-command plane "document.create"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "document.create")))
  (register-command plane "document.update"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "document.update")))
  (register-command plane "document.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "document.delete")))
  (register-command plane "graph.snapshot"
   (lambda (payload envelope)
     (handle-graph-snapshot plane payload envelope)))
  (register-command plane "graph.workspace.put"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.put")))
  (register-command plane "graph.workspace.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.delete")))
  (register-command plane "graph.workspace.activate"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.activate")))
  (register-command plane "graph.node.create"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.node.create")))
  (register-command plane "graph.node.update"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.node.update")))
  (register-command plane "graph.node.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.node.delete")))
  (register-command plane "graph.edge.create"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.edge.create")))
  (register-command plane "graph.edge.update"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.edge.update")))
  (register-command plane "graph.edge.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.edge.delete")))
  plane)

(defun dispatch-message (plane message)
  (destructuring-bind (&key envelope reply) message
    (let* ((id (quasar.protocol:command-envelope-id envelope))
           (command (quasar.protocol:command-envelope-command envelope))
           (payload (quasar.protocol:command-envelope-payload envelope))
           (handler (gethash command (control-plane-handlers plane))))
      (handler-case
          (if handler
              (funcall reply
                       (quasar.protocol:encode-result
                        id (funcall handler payload envelope)))
              (funcall reply
                       (quasar.protocol:encode-error
                        id "protocol.unknown-command"
                        (format nil "Unknown command ~A." command)
                        (quasar.protocol:empty-object))))
        (quasar.protocol:quasar-error (condition)
          (funcall reply (quasar.protocol:quasar-error-to-envelope id condition)))
        (error (condition)
          (format *error-output* "~&[control-plane] unexpected error: ~A~%" condition)
          (funcall reply
                   (quasar.protocol:encode-error
                    id "control-plane.unavailable"
                    "The control plane could not process the command."
                    (quasar.protocol:empty-object))))))))

(defun start-control-plane (plane)
  (unless (control-plane-started-p plane)
    (install-core-commands plane)
    (setf (control-plane-actor-system plane)
          (sento.actor-system:make-actor-system))
    (setf (control-plane-command-actor plane)
          (sento.actor-context:actor-of
           (control-plane-actor-system plane)
           :name "quasar-control-plane"
           :receive (lambda (message)
                      (dispatch-message plane message))))
    (setf (control-plane-started-p plane) t))
  plane)

(defun maybe-shutdown-actor-system (system)
  (let ((symbol (find-symbol "SHUTDOWN" "SENTO.ACTOR-SYSTEM")))
    (when (and symbol (fboundp symbol))
      (funcall symbol system))))

(defun stop-control-plane (plane)
  (when (control-plane-started-p plane)
    (maybe-shutdown-actor-system (control-plane-actor-system plane))
    (setf (control-plane-command-actor plane) nil
          (control-plane-actor-system plane) nil
          (control-plane-started-p plane) nil))
  t)

(defun submit-command (plane encoded reply)
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (let ((envelope (quasar.protocol:decode-command encoded)))
    (sento.actor:tell
     (control-plane-command-actor plane)
     (list :envelope envelope :reply reply))
    (quasar.protocol:command-envelope-id envelope)))

(defun submit-decoded (plane envelope reply)
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (sento.actor:tell
   (control-plane-command-actor plane)
   (list :envelope envelope :reply reply))
  (quasar.protocol:command-envelope-id envelope))
