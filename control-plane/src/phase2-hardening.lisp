(in-package #:quasar.store)

(defun %stage-meta-required (database workspace-id stage-id)
  (let ((meta (tek9:fetch* database (%stage-meta-key workspace-id stage-id))))
    (unless meta
      (%stage-error "import.invalid-session"
                    "The document import session does not exist."))
    (let ((schema-version
            (quasar.protocol:json-value meta "storageSchemaVersion" nil))
          (stored-workspace
            (quasar.protocol:json-value meta "workspaceId" nil))
          (stored-session
            (quasar.protocol:json-value meta "sessionId" nil)))
      (unless (eql schema-version +tek9-schema-version+)
        (%stage-error "storage.unsupported-schema"
                      "The import stage uses an unsupported storage schema."))
      (unless (and (stringp stored-workspace)
                   (string= stored-workspace workspace-id)
                   (stringp stored-session)
                   (string= stored-session stage-id))
        (%stage-error "import.invalid-session"
                      "The import stage identity does not match the request.")))
    meta))

(defmethod promote-import-stage :around
    ((store tek9-store) workspace-id stage-id operation-id client now)
  (let* ((database (tek9-store-database store))
         (before (tek9:fetch* database (%stage-meta-key workspace-id stage-id)))
         (replayed
           (and before
                (string= "COMMITTED"
                         (or (quasar.protocol:json-value before "state" nil) "")))))
    (handler-case
        (let ((result (call-next-method)))
          (quasar.protocol:object-set result "replayed" (if replayed t :false))
          result)
      (quasar.protocol:quasar-error (condition)
        ;; A revision conflict is terminal. The primary method records the
        ;; conflict transactionally, then this wrapper removes the now-useless
        ;; stage namespace. Other failures may be transient/fault-injected and
        ;; therefore deliberately leave the OPEN stage recoverable.
        (when (string= "workspace.revision-conflict"
                       (quasar.protocol:quasar-error-code condition))
          (ignore-errors
            (abort-import-stage store workspace-id stage-id now)))
        (error condition)))))

(in-package #:quasar.control-plane)

(defun handle-import-commit (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-import-commit* plane payload envelope)
      (let* ((store (control-plane-store plane))
             (workspace-id (phase2-workspace-id envelope))
             (stage-id (phase2-stage-id payload))
             (operation-id (next-operation-id))
             (result
               (quasar.store:promote-import-stage
                store
                workspace-id
                stage-id
                operation-id
                (or (quasar.protocol:command-envelope-client envelope) "unknown")
                (get-universal-time)))
             (revision (quasar.protocol:json-value result "revision"))
             (committed-operation-id
               (or (quasar.protocol:json-value result "operationId") operation-id))
             (replayed (eq t (quasar.protocol:json-value result "replayed" nil))))
        (remhash workspace-id (control-plane-workspaces plane))
        (unless replayed
          (broadcast-event
           plane "documents.imported" workspace-id revision committed-operation-id result))
        result)))