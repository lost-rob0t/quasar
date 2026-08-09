(in-package #:quasar.store)

(defclass workspace-store ()
  ()
  (:documentation
   "Persistence boundary for canonical workspace state. The control-plane
actor depends on this abstraction, not on any concrete database, so that an
in-memory implementation can be swapped for CouchDB (or another durable store)
without touching command handlers."))

(defgeneric load-workspace (store workspace-id)
  (:documentation
   "Return the workspace identified by WORKSPACE-ID, or NIL when absent."))

(defgeneric save-workspace (store workspace)
  (:documentation
   "Persist the full canonical WORKSPACE. Must be atomic from the caller's
perspective."))

(defgeneric append-operation (store workspace-id operation)
  (:documentation
   "Append OPERATION to the journal for WORKSPACE-ID. The journal is the
append-only history used for replay and audit. Implementations may no-op when
journaling is not yet durable, but the interface must remain stable."))

(defgeneric commit-workspace (store workspace operation)
  (:documentation
   "Atomically persist WORKSPACE and append OPERATION. No partial state or
journal update may be visible if this operation fails."))

(defclass memory-store (workspace-store)
  ((workspaces :initform (make-hash-table :test #'equal)
               :reader memory-store-workspaces)
   (journals :initform (make-hash-table :test #'equal)
             :reader memory-store-journals)
   (lock :initform (bt:make-lock "quasar-memory-store")
         :reader memory-store-lock))
  (:documentation
   "In-memory workspace store. Acceptable for development and tests as long as
the limitation is documented and the same STORE interface is used everywhere.
CouchDB integration replaces this implementation, not the protocol."))

(defmethod load-workspace ((store memory-store) workspace-id)
  (bt:with-lock-held ((memory-store-lock store))
    (let ((workspace (gethash workspace-id (memory-store-workspaces store))))
      (and workspace (quasar.workspace:copy-workspace workspace)))))

(defmethod save-workspace ((store memory-store) workspace)
  (bt:with-lock-held ((memory-store-lock store))
    (setf (gethash (quasar.workspace:workspace-id workspace)
                   (memory-store-workspaces store))
          (quasar.workspace:copy-workspace workspace)))
  workspace)

(defmethod append-operation ((store memory-store) workspace-id operation)
  (bt:with-lock-held ((memory-store-lock store))
    (let ((journal (gethash workspace-id (memory-store-journals store))))
      (unless journal
        (setf journal (make-array 0 :adjustable t :fill-pointer 0)
              (gethash workspace-id (memory-store-journals store)) journal))
      (vector-push-extend (quasar.protocol:clone-json operation) journal)))
  operation)

(defmethod commit-workspace ((store memory-store) workspace operation)
  (bt:with-lock-held ((memory-store-lock store))
    (let* ((workspace-id (quasar.workspace:workspace-id workspace))
           (journal (or (gethash workspace-id (memory-store-journals store))
                        (make-array 0 :adjustable t :fill-pointer 0)))
           (next-journal (make-array (length journal)
                                     :adjustable t :fill-pointer (length journal))))
      (replace next-journal journal)
      (vector-push-extend (quasar.protocol:clone-json operation) next-journal)
      (setf (gethash workspace-id (memory-store-workspaces store))
            workspace
            (gethash workspace-id (memory-store-journals store)) next-journal)))
  workspace)

(defun store-journal-entries (store workspace-id)
  "Return the journal entries for WORKSPACE-ID as a list, or NIL if absent."
  (bt:with-lock-held ((memory-store-lock store))
    (let ((journal (gethash workspace-id (memory-store-journals store))))
      (when journal
        (map 'list #'quasar.protocol:clone-json journal)))))

(defun make-memory-store ()
  (make-instance 'memory-store))
