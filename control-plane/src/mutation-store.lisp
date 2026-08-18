(in-package #:quasar.store)

(defgeneric direct-workspace-metadata (store workspace-id)
  (:documentation
   "Return durable workspace metadata without restoring canonical records."))

(defgeneric direct-graph-metadata (store workspace-id graph-id)
  (:documentation
   "Return one durable graph metadata record without node/edge hydration."))

(defgeneric direct-mutation-graph (store workspace-id graph-id)
  (:documentation
   "Return one complete durable graph without restoring unrelated graphs/documents."))

(defgeneric direct-graph-node (store workspace-id graph-id node-id)
  (:documentation "Return one canonical graph node sidecar."))

(defgeneric direct-graph-edge (store workspace-id graph-id edge-id)
  (:documentation "Return one canonical graph edge sidecar."))

(defgeneric direct-graph-incident-edges (store workspace-id graph-id node-id)
  (:documentation
   "Return canonical edge sidecars incident on NODE-ID in one graph."))

(defgeneric direct-graph-nodes-referencing-document
    (store workspace-id graph-id document-id)
  (:documentation
   "Return only nodes in GRAPH-ID that reference DOCUMENT-ID."))

(defgeneric direct-document-node-references (store workspace-id document-id)
  (:documentation
   "Return (GRAPH-ID . NODE) pairs that directly reference DOCUMENT-ID."))

(defgeneric direct-document-edge-references (store workspace-id document-id)
  (:documentation
   "Return (GRAPH-ID . EDGE) pairs whose relation document is DOCUMENT-ID."))

(defgeneric direct-document-memberships (store workspace-id document-id)
  (:documentation
   "Return graph metadata records whose explicit membership contains DOCUMENT-ID."))

(defgeneric direct-graph-count (store workspace-id)
  (:documentation "Return the durable named-graph count using bounded scans."))

(defgeneric direct-other-graph-metadata (store workspace-id graph-id)
  (:documentation "Return one graph metadata record whose id differs from GRAPH-ID."))

(defgeneric commit-change-set
    (store workspace-id base-revision committed-revision settings changes journal-entry)
  (:documentation
   "Atomically commit validated record CHANGES, metadata/revision, and JOURNAL-ENTRY."))

(defun %map-prefix-bounded (database prefix function)
  (let ((start nil))
    (loop
      for rows = (%bounded-range database prefix :start start)
      while rows
      do
        (dolist (row rows)
          (funcall function row))
        (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+)))
  nil)

(defun %graph-with-empty-topology (metadata)
  (when metadata
    (let ((graph (quasar.protocol:clone-json metadata)))
      (quasar.protocol:object-set graph "nodes" (quasar.protocol:json-array))
      (quasar.protocol:object-set graph "edges" (quasar.protocol:json-array))
      graph)))

(defun %memory-workspace-or-default (store workspace-id)
  (or (load-workspace store workspace-id)
      (quasar.workspace:make-workspace :id workspace-id)))

(defmethod direct-workspace-metadata ((store memory-store) workspace-id)
  (%workspace-meta-with-document-count
   (%memory-workspace-or-default store workspace-id)))

(defmethod direct-workspace-metadata ((store tek9-store) workspace-id)
  (let* ((database (tek9-store-database store))
         (meta (tek9:fetch* database (%workspace-meta-key workspace-id))))
    (quasar.protocol:clone-json
     (or meta (%default-workspace-meta workspace-id 0 0)))))

(defmethod direct-graph-metadata ((store memory-store) workspace-id graph-id)
  (let ((graph
          (quasar.workspace:workspace-graph
           (%memory-workspace-or-default store workspace-id) graph-id)))
    (and graph
         (quasar.protocol:clone-json (%graph-metadata graph)))))

(defmethod direct-graph-metadata ((store tek9-store) workspace-id graph-id)
  (let ((metadata
          (tek9:fetch*
           (tek9-store-database store)
           (%graph-meta-key workspace-id graph-id))))
    (and metadata (quasar.protocol:clone-json metadata))))

(defmethod direct-mutation-graph ((store memory-store) workspace-id graph-id)
  (let ((graph
          (quasar.workspace:workspace-graph
           (%memory-workspace-or-default store workspace-id) graph-id)))
    (and graph (quasar.protocol:clone-json graph))))

(defmethod direct-mutation-graph ((store tek9-store) workspace-id graph-id)
  (let* ((database (tek9-store-database store))
         (metadata
           (tek9:fetch* database (%graph-meta-key workspace-id graph-id))))
    (unless metadata
      (return-from direct-mutation-graph nil))
    (let* ((graph (%graph-with-empty-topology metadata))
           (namespace (%graph-namespace workspace-id graph-id))
           (nodes
             (loop
               for topology-node in (tek9:fetch-graph-nodes database namespace)
               for node-id = (tek9:node-id topology-node)
               for canonical =
                 (tek9:fetch* database (%node-key workspace-id graph-id node-id))
               do
                 (unless canonical
                   (error "Tek9 graph ~A node ~A has no Quasar sidecar."
                          graph-id node-id))
               collect (quasar.protocol:clone-json canonical)))
           (edges
             (loop
               for topology-edge in (tek9:fetch-graph-edges database namespace)
               for edge-id = (tek9:edge-id topology-edge)
               for canonical =
                 (tek9:fetch* database (%edge-key workspace-id graph-id edge-id))
               do
                 (unless canonical
                   (error "Tek9 graph ~A edge ~A has no Quasar sidecar."
                          graph-id edge-id))
               collect (quasar.protocol:clone-json canonical))))
      (quasar.protocol:object-set
       graph "nodes" (apply #'quasar.protocol:json-array nodes))
      (quasar.protocol:object-set
       graph "edges" (apply #'quasar.protocol:json-array edges))
      graph)))

(defmethod direct-graph-node
    ((store memory-store) workspace-id graph-id node-id)
  (let* ((workspace (%memory-workspace-or-default store workspace-id))
         (graph (quasar.workspace:workspace-graph workspace graph-id))
         (node (and graph (quasar.workspace:graph-node graph node-id))))
    (and node (quasar.protocol:clone-json node))))

(defmethod direct-graph-node
    ((store tek9-store) workspace-id graph-id node-id)
  (let ((node
          (tek9:fetch*
           (tek9-store-database store)
           (%node-key workspace-id graph-id node-id))))
    (and node (quasar.protocol:clone-json node))))

(defmethod direct-graph-edge
    ((store memory-store) workspace-id graph-id edge-id)
  (let* ((workspace (%memory-workspace-or-default store workspace-id))
         (graph (quasar.workspace:workspace-graph workspace graph-id))
         (edge (and graph (quasar.workspace:graph-edge graph edge-id))))
    (and edge (quasar.protocol:clone-json edge))))

(defmethod direct-graph-edge
    ((store tek9-store) workspace-id graph-id edge-id)
  (let ((edge
          (tek9:fetch*
           (tek9-store-database store)
           (%edge-key workspace-id graph-id edge-id))))
    (and edge (quasar.protocol:clone-json edge))))

(defmethod direct-graph-incident-edges
    ((store memory-store) workspace-id graph-id node-id)
  (let* ((workspace (%memory-workspace-or-default store workspace-id))
         (graph (quasar.workspace:workspace-graph workspace graph-id)))
    (when graph
      (loop
        for edge in (quasar.workspace:array-elements
                     (quasar.workspace:graph-edges graph))
        when (or
              (string= node-id
                       (or (quasar.protocol:json-value edge "source") ""))
              (string= node-id
                       (or (quasar.protocol:json-value edge "target") "")))
          collect (quasar.protocol:clone-json edge)))))

(defmethod direct-graph-incident-edges
    ((store tek9-store) workspace-id graph-id node-id)
  (let* ((database (tek9-store-database store))
         (namespace (%graph-namespace workspace-id graph-id))
         (seen (make-hash-table :test #'equal))
         (result nil))
    (dolist
        (topology-edge
         (append
          (tek9:fetch-node-edges
           database node-id :database-name namespace)
          (tek9:fetch-node-edges
           database node-id :database-name namespace :incoming t)))
      (let ((edge-id (tek9:edge-id topology-edge)))
        (unless (gethash edge-id seen)
          (setf (gethash edge-id seen) t)
          (let ((canonical
                  (tek9:fetch*
                   database (%edge-key workspace-id graph-id edge-id))))
            (when canonical
              (push (quasar.protocol:clone-json canonical) result))))))
    (nreverse result)))

(defmethod direct-graph-nodes-referencing-document
    ((store memory-store) workspace-id graph-id document-id)
  (let* ((workspace (%memory-workspace-or-default store workspace-id))
         (graph (quasar.workspace:workspace-graph workspace graph-id)))
    (when graph
      (loop
        for node in (quasar.workspace:array-elements
                     (quasar.workspace:graph-nodes graph))
        when
          (string=
           document-id
           (or (quasar.protocol:json-value node "documentId") ""))
          collect (quasar.protocol:clone-json node)))))

(defmethod direct-graph-nodes-referencing-document
    ((store tek9-store) workspace-id graph-id document-id)
  (let ((database (tek9-store-database store))
        (result nil))
    (%map-prefix-bounded
     database
     (%node-prefix workspace-id graph-id)
     (lambda (row)
       (let ((node (cdr row)))
         (when
             (string=
              document-id
              (or (quasar.protocol:json-value node "documentId") ""))
           (push (quasar.protocol:clone-json node) result)))))
    (nreverse result)))

(defmethod direct-document-node-references
    ((store memory-store) workspace-id document-id)
  (let ((workspace (%memory-workspace-or-default store workspace-id))
        (result nil))
    (loop
      for graph-id being the hash-keys of (quasar.workspace:workspace-graphs workspace)
      using (hash-value graph)
      do
        (dolist
            (node (quasar.workspace:array-elements
                   (quasar.workspace:graph-nodes graph)))
          (when
              (string=
               document-id
               (or (quasar.protocol:json-value node "documentId") ""))
            (push
             (cons graph-id (quasar.protocol:clone-json node))
             result))))
    (nreverse result)))

(defmethod direct-document-node-references
    ((store tek9-store) workspace-id document-id)
  (let ((database (tek9-store-database store))
        (result nil))
    (%map-prefix-bounded
     database
     (%graph-meta-prefix workspace-id)
     (lambda (graph-row)
       (let* ((metadata (cdr graph-row))
              (graph-id (quasar.protocol:json-value metadata "id")))
         (%map-prefix-bounded
          database
          (%node-prefix workspace-id graph-id)
          (lambda (node-row)
            (let ((node (cdr node-row)))
              (when
                  (string=
                   document-id
                   (or (quasar.protocol:json-value node "documentId") ""))
                (push
                 (cons graph-id (quasar.protocol:clone-json node))
                 result))))))))
    (nreverse result)))

(defmethod direct-document-edge-references
    ((store memory-store) workspace-id document-id)
  (let ((workspace (%memory-workspace-or-default store workspace-id))
        (result nil))
    (loop
      for graph-id being the hash-keys of (quasar.workspace:workspace-graphs workspace)
      using (hash-value graph)
      do
        (dolist
            (edge (quasar.workspace:array-elements
                   (quasar.workspace:graph-edges graph)))
          (when
              (string=
               document-id
               (or (quasar.protocol:json-value edge "documentId") ""))
            (push
             (cons graph-id (quasar.protocol:clone-json edge))
             result))))
    (nreverse result)))

(defmethod direct-document-edge-references
    ((store tek9-store) workspace-id document-id)
  (let ((database (tek9-store-database store))
        (result nil))
    (%map-prefix-bounded
     database
     (%graph-meta-prefix workspace-id)
     (lambda (graph-row)
       (let* ((metadata (cdr graph-row))
              (graph-id (quasar.protocol:json-value metadata "id")))
         (%map-prefix-bounded
          database
          (%edge-prefix workspace-id graph-id)
          (lambda (edge-row)
            (let ((edge (cdr edge-row)))
              (when
                  (string=
                   document-id
                   (or (quasar.protocol:json-value edge "documentId") ""))
                (push
                 (cons graph-id (quasar.protocol:clone-json edge))
                 result))))))))
    (nreverse result)))

(defun %membership-contains-p (metadata document-id)
  (let ((ids (quasar.protocol:json-value metadata "documentIds")))
    (and
     (consp ids)
     (member
      document-id
      (if (eq (car ids) :array) (rest ids) ids)
      :test #'string=))))

(defmethod direct-document-memberships
    ((store memory-store) workspace-id document-id)
  (let ((workspace (%memory-workspace-or-default store workspace-id))
        (result nil))
    (loop
      for graph being the hash-values of (quasar.workspace:workspace-graphs workspace)
      when (%membership-contains-p graph document-id)
        do (push (quasar.protocol:clone-json (%graph-metadata graph)) result))
    (nreverse result)))

(defmethod direct-document-memberships
    ((store tek9-store) workspace-id document-id)
  (let ((database (tek9-store-database store))
        (result nil))
    (%map-prefix-bounded
     database
     (%graph-meta-prefix workspace-id)
     (lambda (row)
       (let ((metadata (cdr row)))
         (when (%membership-contains-p metadata document-id)
           (push (quasar.protocol:clone-json metadata) result)))))
    (nreverse result)))

(defmethod direct-graph-count ((store memory-store) workspace-id)
  (hash-table-count
   (quasar.workspace:workspace-graphs
    (%memory-workspace-or-default store workspace-id))))

(defmethod direct-graph-count ((store tek9-store) workspace-id)
  (%count-prefix-bounded
   (tek9-store-database store)
   (%graph-meta-prefix workspace-id)))

(defmethod direct-other-graph-metadata
    ((store memory-store) workspace-id graph-id)
  (let ((workspace (%memory-workspace-or-default store workspace-id)))
    (loop
      for id being the hash-keys of (quasar.workspace:workspace-graphs workspace)
      using (hash-value graph)
      unless (string= id graph-id)
        do (return (quasar.protocol:clone-json (%graph-metadata graph))))))

(defmethod direct-other-graph-metadata
    ((store tek9-store) workspace-id graph-id)
  (let ((database (tek9-store-database store))
        (result nil))
    (block found
      (%map-prefix-bounded
       database
       (%graph-meta-prefix workspace-id)
       (lambda (row)
         (let ((metadata (cdr row)))
           (when
               (not
                (string=
                 graph-id
                 (or (quasar.protocol:json-value metadata "id") "")))
             (setf result (quasar.protocol:clone-json metadata))
             (return-from found result)))))
      result)))

(defun %mutation-document-count-after-change
    (database workspace-id count change)
  (case (quasar.workspace:persistence-change-kind change)
    (:document-upsert
     (if
         (tek9:fetch*
          database
          (%document-key
           workspace-id
           (quasar.workspace:persistence-change-id change)))
         count
         (1+ count)))
    (:document-delete
     (if
         (tek9:fetch*
          database
          (%document-key
           workspace-id
           (quasar.workspace:persistence-change-id change)))
         (max 0 (1- count))
         count))
    (otherwise count)))

(defun %mutation-meta
    (workspace-id current-meta committed-revision document-count settings)
  (let ((meta
          (quasar.protocol:clone-json
           (or
            current-meta
            (%default-workspace-meta workspace-id 0 document-count)))))
    (quasar.protocol:object-set
     meta "storageSchemaVersion" +tek9-schema-version+)
    (quasar.protocol:object-set meta "workspaceId" workspace-id)
    (quasar.protocol:object-set meta "revision" committed-revision)
    (quasar.protocol:object-set meta "documentCount" document-count)
    (quasar.protocol:object-set
     meta "settings" (quasar.protocol:clone-json settings))
    (quasar.protocol:object-set
     meta
     "activeGraphId"
     (or (quasar.protocol:json-value settings "activeGraphId")
         (quasar.protocol:json-value meta "activeGraphId")
         "all-documents"))
    meta))

(defun %run-mutation-hook (store point)
  (let ((hook (tek9-store-failure-hook store)))
    (when hook
      (funcall hook point))))

(defmethod commit-change-set
    ((store tek9-store)
     workspace-id
     base-revision
     committed-revision
     settings
     changes
     journal-entry)
  (let* ((database (tek9-store-database store))
         (stats (%fresh-commit-stats)))
    (tek9:with-write-transaction (database)
      (let* ((current-meta
               (tek9:fetch* database (%workspace-meta-key workspace-id)))
             (current-revision
               (or
                (and current-meta
                     (quasar.protocol:json-value current-meta "revision"))
                0))
             (document-count
               (%canonical-document-count
                database workspace-id current-meta)))
        (unless (= base-revision current-revision)
          (error
           'quasar.protocol:quasar-error
           :code "workspace.revision-conflict"
           :message
           (format nil
                   "Tek9 workspace ~A is at revision ~A, expected ~A."
                   workspace-id current-revision base-revision)))
        (%ensure-default-graph-metadata database workspace-id)
        (%run-mutation-hook store :before-mutation-changes)
        (loop
          for change across changes
          do
            (setf
             document-count
             (%mutation-document-count-after-change
              database workspace-id document-count change))
            (%apply-change store workspace-id change stats))
        (%run-mutation-hook store :after-mutation-changes)
        (%run-mutation-hook store :before-mutation-revision)
        (%put-record
         database
         (%workspace-meta-key workspace-id)
         (%mutation-meta
          workspace-id
          current-meta
          committed-revision
          document-count
          settings))
        (%run-mutation-hook store :before-mutation-journal)
        (%put-record
         database
         (%journal-key workspace-id journal-entry)
         journal-entry)
        (%run-mutation-hook store :before-commit)))
    (setf (tek9-store-last-commit-stats store) stats)
    stats))