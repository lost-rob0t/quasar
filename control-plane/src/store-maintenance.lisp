(in-package #:quasar.store)

(defmethod save-workspace :around ((store tek9-store) workspace)
  "Make explicit full workspace replacement remove superseded graph topology.

Normal control-plane mutations do not use SAVE-WORKSPACE. This around method is
for bootstrap/migration callers that intentionally replace a complete workspace:
it clears every previously persisted logical graph namespace before the primary
method rewrites the requested workspace. The primary method's nested Tek9 write
boundary reuses this outer transaction, so topology cleanup and replacement are
one atomic LMDB commit."
  (let* ((database (tek9-store-database store))
         (workspace-id (quasar.workspace:workspace-id workspace))
         (existing-graphs
           (%range-values database (%graph-meta-prefix workspace-id))))
    (tek9:with-write-transaction (database)
      (dolist (graph-metadata existing-graphs)
        (let ((graph-id (quasar.protocol:json-value graph-metadata "id")))
          (when graph-id
            (tek9:clear-graph database (%graph-namespace workspace-id graph-id)))))
      (call-next-method))))
