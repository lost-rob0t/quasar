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
                        &key transaction-id event-index)
  (let ((encoded (quasar.protocol:encode-event
                  event workspace-id revision operation-id payload
                  :transaction-id transaction-id :event-index event-index)))
    (loop for handler being the hash-values of (control-plane-subscribers plane)
          do (funcall handler encoded))))

(defun next-operation-id ()
  (format nil "op-~36R-~36R" (get-universal-time) (random most-positive-fixnum)))

(defun next-transaction-id ()
  (format nil "txn-~36R-~36R" (get-universal-time) (random most-positive-fixnum)))

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
         (applied (quasar.workspace:dispatch-operation workspace operation))
         (operation-id (next-operation-id)))
    (incf (quasar.workspace:workspace-revision workspace))
    (let ((result-obj (applied-op-result applied)))
      (quasar.protocol:object-set result-obj "operationId" operation-id)
      (quasar.protocol:object-set result-obj "revision"
                                  (quasar.workspace:workspace-revision workspace))
      (quasar.protocol:object-set result-obj "event" (applied-op-event applied)))
    (quasar.store:save-workspace (control-plane-store plane) workspace)
    (quasar.store:append-operation
     (control-plane-store plane) (quasar.workspace:workspace-id workspace)
     (quasar.protocol:json-object
      (cons "operationId" operation-id)
      (cons "revision" (quasar.workspace:workspace-revision workspace))
      (cons "operation" (quasar.protocol:clone-json operation))))
    (broadcast-event plane
                     (applied-op-event applied)
                     (quasar.workspace:workspace-id workspace)
                     (quasar.workspace:workspace-revision workspace)
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
    (when (and expected-revision
               (/= expected-revision (quasar.workspace:workspace-revision workspace)))
      (error 'quasar.protocol:quasar-error
             :code "workspace.revision-conflict"
             :message (format nil "Expected revision ~A but current is ~A."
                              expected-revision
                              (quasar.workspace:workspace-revision workspace))))
    (let ((candidate (quasar.workspace:make-workspace
                      :id (quasar.workspace:workspace-id workspace))))
      (copy-workspace-state workspace candidate)
      (handler-case
          (multiple-value-bind (events inverses)
              (quasar.workspace:commit-operations candidate (array-elements operations))
            (declare (ignore inverses))
            (commit-workspace plane envelope workspace candidate)
            (let* ((transaction-id (next-transaction-id))
                   (revision (incf (quasar.workspace:workspace-revision workspace))))
              (quasar.store:save-workspace (control-plane-store plane) workspace)
              (loop for event in events
                    for n from 1
                    do (broadcast-event plane
                                        event
                                        (quasar.workspace:workspace-id workspace)
                                        revision
                                        (format nil "~A-~D" transaction-id n)
                                        (quasar.protocol:json-object
                                         (cons "index" n))
                                        :transaction-id transaction-id
                                        :event-index n))
              (quasar.store:append-operation
               (control-plane-store plane) (quasar.workspace:workspace-id workspace)
               (quasar.protocol:json-object
                (cons "transactionId" transaction-id)
                (cons "revision" revision)
                (cons "operations" (quasar.protocol:clone-json operations))))
              (quasar.protocol:json-object
               (cons "operationId" transaction-id)
               (cons "transactionId" transaction-id)
               (cons "revision" revision)
               (cons "workspaceId" (quasar.workspace:workspace-id workspace))
               (cons "events" (apply #'quasar.protocol:json-array
                                     (loop for e in events
                                           for n from 1
                                           collect (quasar.protocol:json-object
                                                    (cons "event" e)
                                                    (cons "index" n))))))))
        (error (condition)
          (declare (ignore condition))
          (error 'quasar.protocol:quasar-error
                 :code "transaction.failed"
                 :message "One or more operations failed; the transaction was rolled back."
                 :details (quasar.protocol:json-object
                           (cons "applied" 0))))))))

(defun copy-workspace-state (source target)
  "Deep-clone all state from SOURCE to TARGET: documents, graphs (including
nodes/edges arrays), settings, and revision. The journal is NOT copied
because it is an append-only history of operations on the authoritative
workspace, not part of the mutable state that a transaction candidate needs."
  (setf (quasar.workspace:workspace-revision target)
        (quasar.workspace:workspace-revision source))
  (clrhash (quasar.workspace:workspace-documents target))
  (clrhash (quasar.workspace:workspace-graphs target))
  (clrhash (quasar.workspace:workspace-settings target))
  (loop for key being the hash-keys of (quasar.workspace:workspace-documents source)
        using (hash-value value)
        do (setf (gethash key (quasar.workspace:workspace-documents target))
                 (quasar.protocol:clone-json value)))
  (loop for key being the hash-keys of (quasar.workspace:workspace-graphs source)
        using (hash-value value)
        do (setf (gethash key (quasar.workspace:workspace-graphs target))
                 (quasar.protocol:clone-json value)))
  (loop for key being the hash-keys of (quasar.workspace:workspace-settings source)
        using (hash-value value)
        do (setf (gethash key (quasar.workspace:workspace-settings target))
                 (quasar.protocol:clone-json value))))

(defun commit-workspace (plane envelope old new)
  "Copy candidate state back into the authoritative workspace."
  (declare (ignore plane envelope))
  (copy-workspace-state new old))

(defun handle-snapshot (plane payload envelope)
  (declare (ignore payload))
  (quasar.workspace:workspace-snapshot (workspace-for plane envelope)))

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
