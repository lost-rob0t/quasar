(in-package #:quasar.workspace)

(defstruct (persistence-change
            (:constructor make-persistence-change
                (&key kind graph-id id value)))
  kind
  graph-id
  id
  value)

(defclass persistent-workspace (workspace)
  ((persistence-changes
    :initform (make-array 0 :adjustable t :fill-pointer 0)
    :reader workspace-persistence-changes))
  (:documentation
   "A candidate workspace carrying already-validated storage deltas.

The delta is runtime metadata, not canonical workspace data. COPY-WORKSPACE
never copies it, so a committed candidate becomes an ordinary active cache
whose next candidate starts with an empty commit plan."))

(defun clear-workspace-persistence-changes (workspace)
  (when (typep workspace 'persistent-workspace)
    (setf (fill-pointer (workspace-persistence-changes workspace)) 0))
  workspace)

(defun copy-workspace (source)
  "Return a deeply isolated mutation candidate with an empty persistence plan."
  (let ((copy (make-instance 'persistent-workspace :id (workspace-id source))))
    (setf (workspace-revision copy) (workspace-revision source))
    (loop for key being the hash-keys of (workspace-documents source)
          using (hash-value value)
          do (setf (gethash key (workspace-documents copy))
                   (quasar.protocol:clone-json value)))
    (loop for key being the hash-keys of (workspace-graphs source)
          using (hash-value value)
          do (setf (gethash key (workspace-graphs copy))
                   (quasar.protocol:clone-json value)))
    (loop for key being the hash-keys of (workspace-settings source)
          using (hash-value value)
          do (setf (gethash key (workspace-settings copy))
                   (quasar.protocol:clone-json value)))
    (loop for entry across (workspace-journal source)
          do (vector-push-extend (quasar.protocol:clone-json entry)
                                 (workspace-journal copy)))
    copy))

(defun %record-persistence-change (workspace change)
  (when (typep workspace 'persistent-workspace)
    (vector-push-extend change (workspace-persistence-changes workspace)))
  change)

(defun %graph-metadata-change (workspace graph-id)
  (let ((graph (workspace-graph workspace graph-id)))
    (and graph
         (make-persistence-change
          :kind :graph-metadata-upsert
          :graph-id graph-id
          :value (quasar.protocol:clone-json graph)))))

(defun %result-value (applied key)
  (quasar.protocol:json-value (applied-op-result applied) key))

(defun %operation-persistence-changes (workspace operation applied)
  "Compile one successful application result into canonical storage changes.

This function runs only after the ordinary workspace functions have validated
and mutated the candidate. It does not implement application validation and the
store never needs to reinterpret command semantics."
  (let* ((type (quasar.protocol:json-value operation "type"))
         (payload (or (quasar.protocol:json-value operation "payload")
                      (quasar.protocol:empty-object)))
         (result (applied-op-result applied)))
    (cond
      ((string= type "document.create")
       (list (make-persistence-change
              :kind :document-upsert
              :id (%result-value applied "documentId")
              :value (quasar.protocol:clone-json (%result-value applied "created")))))
      ((string= type "document.update")
       (list (make-persistence-change
              :kind :document-upsert
              :id (%result-value applied "documentId")
              :value (quasar.protocol:clone-json (%result-value applied "updated")))))
      ((string= type "document.delete")
       (cons (make-persistence-change
              :kind :document-delete
              :id (%result-value applied "documentId"))
             (loop for graph-id in (array-elements
                                    (or (%result-value applied "removedFromGraphs")
                                        (quasar.protocol:json-array)))
                   for change = (%graph-metadata-change workspace graph-id)
                   when change collect change)))
      ((string= type "document.restore")
       (cons (make-persistence-change
              :kind :document-upsert
              :id (%result-value applied "documentId")
              :value (quasar.protocol:clone-json (%result-value applied "created")))
             (loop for graph-id in (array-elements
                                    (quasar.protocol:json-value payload "graphIds"))
                   for change = (%graph-metadata-change workspace graph-id)
                   when change collect change)))
      ((member type '("graph.node.create" "graph.node.update") :test #'string=)
       (let* ((graph-id (%result-value applied "graphId"))
              (node (or (%result-value applied "created")
                        (%result-value applied "updated"))))
         (remove nil
                 (list (make-persistence-change
                        :kind :node-upsert
                        :graph-id graph-id
                        :id (%result-value applied "nodeId")
                        :value (quasar.protocol:clone-json node))
                       (%graph-metadata-change workspace graph-id)))))
      ((string= type "graph.node.delete")
       (let ((graph-id (%result-value applied "graphId")))
         (append
          (list (make-persistence-change
                 :kind :node-delete
                 :graph-id graph-id
                 :id (%result-value applied "nodeId")))
          (loop for edge in (array-elements
                             (or (%result-value applied "removedEdges")
                                 (quasar.protocol:json-array)))
                collect (make-persistence-change
                         :kind :edge-delete
                         :graph-id graph-id
                         :id (quasar.protocol:json-value edge "id")))
          (let ((metadata (%graph-metadata-change workspace graph-id)))
            (and metadata (list metadata))))))
      ((string= type "graph.node.restore")
       (let* ((graph-id (%result-value applied "graphId"))
              (node (%result-value applied "created")))
         (append
          (list (make-persistence-change
                 :kind :node-upsert
                 :graph-id graph-id
                 :id (%result-value applied "nodeId")
                 :value (quasar.protocol:clone-json node)))
          (loop for edge in (array-elements
                             (quasar.protocol:json-value payload "edges"))
                collect (make-persistence-change
                         :kind :edge-upsert
                         :graph-id graph-id
                         :id (quasar.protocol:json-value edge "id")
                         :value (quasar.protocol:clone-json edge)))
          (let ((metadata (%graph-metadata-change workspace graph-id)))
            (and metadata (list metadata))))))
      ((member type '("graph.edge.create" "graph.edge.update") :test #'string=)
       (let ((edge (or (%result-value applied "created")
                       (%result-value applied "updated"))))
         (list (make-persistence-change
                :kind :edge-upsert
                :graph-id (%result-value applied "graphId")
                :id (%result-value applied "edgeId")
                :value (quasar.protocol:clone-json edge)))))
      ((string= type "graph.edge.delete")
       (list (make-persistence-change
              :kind :edge-delete
              :graph-id (%result-value applied "graphId")
              :id (%result-value applied "edgeId"))))
      ((string= type "graph.put")
       (let* ((graph-id (%result-value applied "graphId"))
              (graph (workspace-graph workspace graph-id)))
         (list (make-persistence-change
                :kind :graph-replace
                :graph-id graph-id
                :id graph-id
                :value (quasar.protocol:clone-json graph)))))
      ((string= type "graph.delete")
       (list (make-persistence-change
              :kind :graph-delete
              :graph-id (%result-value applied "graphId")
              :id (%result-value applied "graphId"))))
      ((string= type "graph.activate")
       nil)
      (t
       (error "No persistence compiler for validated operation ~S." type)))))

(defvar *base-dispatch-operation*
  (symbol-function 'dispatch-operation)
  "The workspace dispatcher before persistence-plan instrumentation.")

(defun dispatch-operation (workspace operation)
  "Dispatch OPERATION and append its already-validated storage delta.

The ordinary workspace dispatcher remains the only place that applies command
semantics. Persistence changes are derived from its canonical APPLIED-OP only
after successful validation and mutation."
  (let ((applied (funcall *base-dispatch-operation* workspace operation)))
    (dolist (change (%operation-persistence-changes workspace operation applied))
      (%record-persistence-change workspace change))
    applied))
