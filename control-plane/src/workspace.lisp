(in-package #:quasar.workspace)

(defclass workspace ()
  ((id :initarg :id :reader workspace-id)
   (revision :initform 0 :accessor workspace-revision)
   (documents :initform (make-hash-table :test #'equal)
              :reader workspace-documents)
   (graphs :initform (make-hash-table :test #'equal)
           :reader workspace-graphs)
   (settings :initform (make-hash-table :test #'equal)
             :reader workspace-settings)
   (journal :initform (make-array 0 :adjustable t :fill-pointer 0)
            :reader workspace-journal))
  (:documentation "Canonical, single-writer-owned workspace state."))

(defun make-workspace (&key (id "default"))
  (make-instance 'workspace :id id))

(defun workspace-graph (workspace graph-id)
  (gethash graph-id (workspace-graphs workspace)))

(defun (setf workspace-graph) (graph workspace graph-id)
  (setf (gethash graph-id (workspace-graphs workspace)) graph))

(defun graph-nodes (graph)
  (or (quasar.protocol:json-value graph "nodes")
      (let ((nodes (quasar.protocol:json-array)))
        (quasar.protocol:object-set graph "nodes" nodes)
        nodes)))

(defun graph-edges (graph)
  (or (quasar.protocol:json-value graph "edges")
      (let ((edges (quasar.protocol:json-array)))
        (quasar.protocol:object-set graph "edges" edges)
        edges)))

(defun graph-node (graph node-id)
  (let ((nodes (rest (graph-nodes graph))))
    (find node-id nodes :key (lambda (n) (quasar.protocol:json-value n "id"))
                        :test #'string=)))

(defun graph-edge (graph edge-id)
  (let ((edges (rest (graph-edges graph))))
    (find edge-id edges :key (lambda (e) (quasar.protocol:json-value e "id"))
                        :test #'string=)))

(defun ensure-graph (workspace graph-id)
  (let ((graph (workspace-graph workspace graph-id)))
    (unless graph
      (setf graph (quasar.protocol:json-object
                   (cons "id" graph-id)
                   (cons "nodes" (quasar.protocol:json-array))
                   (cons "edges" (quasar.protocol:json-array)))
            (workspace-graph workspace graph-id) graph))
    graph))

(defun hash-table-values (table)
  (loop for value being the hash-values of table collect value))

(defun hash-table-object (table)
  (apply #'quasar.protocol:json-object
         (loop for key being the hash-keys of table
               using (hash-value value)
               collect (cons key value))))

(defun workspace-snapshot (workspace)
  (quasar.protocol:json-object
   (cons "id" (workspace-id workspace))
   (cons "revision" (workspace-revision workspace))
   (cons "documents"
         (apply #'quasar.protocol:json-array
                (hash-table-values (workspace-documents workspace))))
   (cons "graphs"
         (apply #'quasar.protocol:json-array
                (hash-table-values (workspace-graphs workspace))))
   (cons "settings" (hash-table-object (workspace-settings workspace)))))

(defun graph-snapshot (workspace graph-id)
  (let ((graph (workspace-graph workspace graph-id)))
    (unless graph
      (error 'quasar.protocol:quasar-error
             :code "graph.node-not-found"
             :message (format nil "Graph ~A does not exist." graph-id)))
    graph))

(defun require-document (workspace document-id)
  (let ((document (gethash document-id (workspace-documents workspace))))
    (unless document
      (error 'quasar.protocol:quasar-error
             :code "document.not-found"
             :message (format nil "Document ~A does not exist." document-id)))
    document))

(defun require-graph-node (graph node-id)
  (let ((node (graph-node graph node-id)))
    (unless node
      (error 'quasar.protocol:quasar-error
             :code "graph.node-not-found"
             :message (format nil "Node ~A does not exist." node-id)))
    node))

(defun require-graph-edge (graph edge-id)
  (let ((edge (graph-edge graph edge-id)))
    (unless edge
      (error 'quasar.protocol:quasar-error
             :code "graph.edge-not-found"
             :message (format nil "Edge ~A does not exist." edge-id)))
    edge))

(defun require-valid-document (document)
  (quasar.protocol:ensure-object document "document")
  (quasar.protocol:ensure-string (quasar.protocol:json-value document "_id") "_id"
                                 "document.invalid")
  document)

(defun require-valid-node (node)
  (quasar.protocol:ensure-object node "node")
  (quasar.protocol:ensure-string (quasar.protocol:json-value node "id") "id"
                                 "document.invalid")
  (let ((doc-ref (quasar.protocol:json-value node "documentId")))
    (when doc-ref
      (quasar.protocol:ensure-string doc-ref "documentId" "document.invalid")))
  node)

(defun require-valid-edge (edge graph)
  (quasar.protocol:ensure-object edge "edge")
  (quasar.protocol:ensure-string (quasar.protocol:json-value edge "id") "id"
                                 "graph.invalid-reference")
  (let ((source (quasar.protocol:json-value edge "source"))
        (target (quasar.protocol:json-value edge "target")))
    (quasar.protocol:ensure-string source "source" "graph.invalid-reference")
    (quasar.protocol:ensure-string target "target" "graph.invalid-reference")
    (unless (graph-node graph source)
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid-reference"
             :message (format nil "Edge source ~A does not exist." source)))
    (unless (graph-node graph target)
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid-reference"
             :message (format nil "Edge target ~A does not exist." target))))
  edge)

(defun add-array-item (array item id-field)
  (let ((items (rest array)))
    (when (find (quasar.protocol:json-value item id-field) items
                :key (lambda (n) (quasar.protocol:json-value n id-field))
                :test #'string=)
      (error 'quasar.protocol:quasar-error
             :code "document.invalid"
             :message (format nil "Duplicate id ~A."
                              (quasar.protocol:json-value item id-field))))
    (setf (rest array) (append items (list item))))
  item)

(defun replace-array-item (array item id-field)
  (let* ((items (rest array))
         (id (quasar.protocol:json-value item id-field))
         (position (position id items
                            :key (lambda (n) (quasar.protocol:json-value n id-field))
                            :test #'string=)))
    (unless position
      (error 'quasar.protocol:quasar-error
             :code "graph.node-not-found"
             :message (format nil "Item ~A does not exist." id)))
    (setf (nth position items) item))
  item)

(defun remove-array-item (array id id-field code not-found-message)
  (let* ((items (rest array))
         (position (position id items
                            :key (lambda (n) (quasar.protocol:json-value n id-field))
                            :test #'string=)))
    (unless position
      (error 'quasar.protocol:quasar-error
             :code code
             :message not-found-message))
    (setf (rest array) (delete-if (lambda (n)
                                   (string= (quasar.protocol:json-value n id-field) id))
                                 items)))
  id)

(defstruct (applied-op
            (:constructor make-applied-op))
  event
  result
  inverse)

(defun apply-document-create (workspace payload)
  (require-valid-document payload)
  (let ((id (quasar.protocol:json-value payload "_id")))
    (when (gethash id (workspace-documents workspace))
      (error 'quasar.protocol:quasar-error
             :code "document.invalid"
             :message (format nil "Document ~A already exists." id)))
    (setf (gethash id (workspace-documents workspace)) payload)
    (make-applied-op
     :event "document.created"
     :result (quasar.protocol:json-object (cons "created" id))
     :inverse (quasar.protocol:json-object
               (cons "type" "document.delete")
               (cons "payload" (quasar.protocol:json-object (cons "id" id)))))))

(defun apply-document-update (workspace payload)
  (let ((id (quasar.protocol:json-value payload "_id")))
    (require-valid-document payload)
    (let ((previous (require-document workspace id)))
      (setf (gethash id (workspace-documents workspace)) payload)
      (make-applied-op
       :event "document.updated"
       :result (quasar.protocol:json-object (cons "updated" id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "document.create")
                 (cons "payload" previous))))))

(defun apply-document-delete (workspace payload)
  (let ((id (quasar.protocol:ensure-string
             (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (let ((previous (require-document workspace id)))
      (remhash id (workspace-documents workspace))
      (make-applied-op
       :event "document.deleted"
       :result (quasar.protocol:json-object (cons "deleted" id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "document.create")
                 (cons "payload" previous))))))

(defun apply-node-create (workspace payload)
  (require-valid-node payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (ensure-graph workspace graph-id))
         (nodes (graph-nodes graph)))
    (add-array-item nodes payload "id")
    (make-applied-op
     :event "graph.node.created"
     :result (quasar.protocol:json-object
              (cons "graphId" graph-id)
              (cons "created" (quasar.protocol:json-value payload "id")))
     :inverse (quasar.protocol:json-object
               (cons "type" "graph.node.delete")
               (cons "payload"
                     (quasar.protocol:json-object
                      (cons "graphId" graph-id)
                      (cons "id" (quasar.protocol:json-value payload "id"))))))))

(defun apply-node-update (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (ensure-graph workspace graph-id))
         (node-id (quasar.protocol:ensure-string
                   (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (require-valid-node payload)
    (let ((previous (require-graph-node graph node-id)))
      (replace-array-item (graph-nodes graph) payload "id")
      (make-applied-op
       :event "graph.node.updated"
       :result (quasar.protocol:json-object
                (cons "graphId" graph-id)
                (cons "updated" node-id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.node.update")
                 (cons "payload"
                       (quasar.protocol:json-object
                        (cons "graphId" graph-id)
                        (cons "node" previous))))))))

(defun apply-node-delete (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (ensure-graph workspace graph-id))
         (node-id (quasar.protocol:ensure-string
                   (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (let ((previous (require-graph-node graph node-id)))
      (remove-array-item (graph-nodes graph) node-id "id"
                         "graph.node-not-found"
                         (format nil "Node ~A does not exist." node-id))
      (make-applied-op
       :event "graph.node.deleted"
       :result (quasar.protocol:json-object
                (cons "graphId" graph-id)
                (cons "deleted" node-id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.node.create")
                 (cons "payload"
                       (quasar.protocol:json-object
                        (cons "graphId" graph-id)
                        (cons "node" previous))))))))

(defun apply-edge-create (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (ensure-graph workspace graph-id)))
    (require-valid-edge payload graph)
    (add-array-item (graph-edges graph) payload "id")
    (make-applied-op
     :event "graph.edge.created"
     :result (quasar.protocol:json-object
              (cons "graphId" graph-id)
              (cons "created" (quasar.protocol:json-value payload "id")))
     :inverse (quasar.protocol:json-object
               (cons "type" "graph.edge.delete")
               (cons "payload"
                     (quasar.protocol:json-object
                      (cons "graphId" graph-id)
                      (cons "id" (quasar.protocol:json-value payload "id"))))))))

(defun apply-edge-update (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (ensure-graph workspace graph-id))
         (edge-id (quasar.protocol:ensure-string
                   (quasar.protocol:json-value payload "id") "id" "graph.invalid-reference")))
    (require-valid-edge payload graph)
    (let ((previous (require-graph-edge graph edge-id)))
      (replace-array-item (graph-edges graph) payload "id")
      (make-applied-op
       :event "graph.edge.updated"
       :result (quasar.protocol:json-object
                (cons "graphId" graph-id)
                (cons "updated" edge-id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.edge.update")
                 (cons "payload"
                       (quasar.protocol:json-object
                        (cons "graphId" graph-id)
                        (cons "edge" previous))))))))

(defun apply-edge-delete (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (ensure-graph workspace graph-id))
         (edge-id (quasar.protocol:ensure-string
                   (quasar.protocol:json-value payload "id") "id" "graph.invalid-reference")))
    (let ((previous (require-graph-edge graph edge-id)))
      (remove-array-item (graph-edges graph) edge-id "id"
                         "graph.edge-not-found"
                         (format nil "Edge ~A does not exist." edge-id))
      (make-applied-op
       :event "graph.edge.deleted"
       :result (quasar.protocol:json-object
                (cons "graphId" graph-id)
                (cons "deleted" edge-id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.edge.create")
                 (cons "payload"
                       (quasar.protocol:json-object
                        (cons "graphId" graph-id)
                        (cons "edge" previous))))))))

(defun dispatch-operation (workspace operation)
  (let ((type (quasar.protocol:json-value operation "type"))
        (payload (or (quasar.protocol:json-value operation "payload")
                     (quasar.protocol:json-value operation "node")
                     (quasar.protocol:json-value operation "edge")
                     (quasar.protocol:empty-object))))
    (cond
      ((string= type "document.create")
       (apply-document-create workspace payload))
      ((string= type "document.update")
       (apply-document-update workspace payload))
      ((string= type "document.delete")
       (apply-document-delete workspace payload))
      ((string= type "graph.node.create")
       (apply-node-create workspace payload))
      ((string= type "graph.node.update")
       (apply-node-update workspace payload))
      ((string= type "graph.node.delete")
       (apply-node-delete workspace payload))
      ((string= type "graph.edge.create")
       (apply-edge-create workspace payload))
      ((string= type "graph.edge.update")
       (apply-edge-update workspace payload))
      ((string= type "graph.edge.delete")
       (apply-edge-delete workspace payload))
      (t
       (error 'quasar.protocol:quasar-error
              :code "protocol.unknown-command"
              :message (format nil "Unknown operation type ~S." type))))))

(defun commit-operations (workspace operations)
  "Apply every operation, collecting events. Signals on the first failure and
leaves WORKSPACE unchanged (caller is responsible for using a candidate copy
for transaction isolation)."
  (let ((events '())
        (inverses '()))
    (dolist (operation operations)
      (let ((applied (dispatch-operation workspace operation)))
        (push (applied-op-event applied) events)
        (push (applied-op-inverse applied) inverses)))
    (values (nreverse events) (nreverse inverses))))
