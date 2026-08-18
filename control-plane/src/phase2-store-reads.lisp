(in-package #:quasar.store)

(defgeneric direct-workspace-revision (store workspace-id)
  (:documentation "Return the durable canonical workspace revision without restoring its corpus."))

(defgeneric direct-graph-snapshot (store workspace-id graph-id)
  (:documentation "Return one durable graph without restoring the document corpus."))

(defmethod direct-workspace-revision ((store memory-store) workspace-id)
  (let ((workspace (load-workspace store workspace-id)))
    (if workspace
        (quasar.workspace:workspace-revision workspace)
        0)))

(defmethod direct-workspace-revision ((store tek9-store) workspace-id)
  (let* ((database (tek9-store-database store))
         (meta (tek9:fetch* database (%workspace-meta-key workspace-id))))
    (or (and meta (quasar.protocol:json-value meta "revision")) 0)))

(defmethod direct-graph-snapshot ((store memory-store) workspace-id graph-id)
  (let ((workspace (load-workspace store workspace-id)))
    (unless workspace
      (error 'quasar.protocol:quasar-error
             :code "graph.not-found"
             :message (format nil "Graph ~A does not exist." graph-id)))
    (quasar.workspace:graph-snapshot workspace graph-id)))

(defmethod direct-graph-snapshot ((store tek9-store) workspace-id graph-id)
  (let ((database (tek9-store-database store)))
    (tek9:with-read-transaction (database)
      (let ((meta (tek9:fetch* database (%graph-meta-key workspace-id graph-id))))
        (unless meta
          (error 'quasar.protocol:quasar-error
                 :code "graph.not-found"
                 :message (format nil "Graph ~A does not exist." graph-id)))
        (let* ((workspace-meta
                 (or (tek9:fetch* database (%workspace-meta-key workspace-id))
                     (%default-workspace-meta workspace-id 0 0)))
               (workspace (%restore-metadata-workspace store workspace-id workspace-meta))
               (graph (quasar.workspace:workspace-graph workspace graph-id)))
          (unless graph
            (error 'quasar.protocol:quasar-error
                   :code "graph.not-found"
                   :message (format nil "Graph ~A does not exist." graph-id)))
          (quasar.protocol:clone-json graph))))))