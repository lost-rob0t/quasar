(in-package #:quasar.store)

(defmethod save-workspace :around ((store tek9-store) workspace)
  "Make explicit full workspace replacement remove superseded graph topology.

Normal control-plane mutations do not use SAVE-WORKSPACE. This around method is
for bootstrap/migration callers that intentionally replace a complete workspace:
it clears every previously persisted logical graph namespace before the primary
method rewrites the requested workspace. Enumeration, topology cleanup, and the
primary method's replacement all share one Tek9 write transaction, so there is
no read/write gap and no partially cleaned durable state."
  (let ((database (tek9-store-database store))
        (workspace-id (quasar.workspace:workspace-id workspace)))
    (tek9:with-write-transaction (database)
      (dolist (graph-metadata
               (%range-values database (%graph-meta-prefix workspace-id)))
        (let ((graph-id (quasar.protocol:json-value graph-metadata "id")))
          (when graph-id
            (tek9:clear-graph database (%graph-namespace workspace-id graph-id)))))
      (call-next-method))))
