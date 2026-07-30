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

(defclass memory-store (workspace-store)
  ((workspaces :initform (make-hash-table :test #'equal)
               :reader memory-store-workspaces)
   (journals :initform (make-hash-table :test #'equal)
             :reader memory-store-journals))
  (:documentation
   "In-memory workspace store. Acceptable for development and tests as long as
the limitation is documented and the same STORE interface is used everywhere.
CouchDB integration replaces this implementation, not the protocol."))

(defmethod load-workspace ((store memory-store) workspace-id)
  (gethash workspace-id (memory-store-workspaces store)))

(defmethod save-workspace ((store memory-store) workspace)
  (setf (gethash (quasar.workspace:workspace-id workspace)
                 (memory-store-workspaces store))
        workspace)
  workspace)

(defmethod append-operation ((store memory-store) workspace-id operation)
  (let ((journal (gethash workspace-id (memory-store-journals store))))
    (unless journal
      (setf journal (make-array 0 :adjustable t :fill-pointer 0)
            (gethash workspace-id (memory-store-journals store)) journal))
    (vector-push-extend operation journal))
  operation)

(defun make-memory-store ()
  (make-instance 'memory-store))
