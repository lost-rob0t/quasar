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
  (let ((workspace (make-instance 'workspace :id id)))
    (ensure-graph workspace "all-documents")
    (setf (gethash "activeGraphId" (workspace-settings workspace))
          "all-documents")
    workspace))

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

(defun array-elements (array)
  (if (and (consp array) (eq (car array) :array))
      (rest array)
      array))

(defun graph-node (graph node-id)
  (let ((nodes (array-elements (graph-nodes graph))))
    (find node-id nodes :key (lambda (n) (quasar.protocol:json-value n "id"))
                        :test #'string=)))

(defun graph-edge (graph edge-id)
  (let ((edges (array-elements (graph-edges graph))))
    (find edge-id edges :key (lambda (e) (quasar.protocol:json-value e "id"))
                        :test #'string=)))

(defun ensure-graph (workspace graph-id)
  (let ((graph (workspace-graph workspace graph-id)))
    (unless graph
      (setf graph (quasar.protocol:json-object
                   (cons "id" graph-id)
                   (cons "name" graph-id)
                   (cons "nodes" (quasar.protocol:json-array))
                   (cons "edges" (quasar.protocol:json-array))
                   (cons "documentIds" (if (string= graph-id "all-documents")
                                            :null
                                            (quasar.protocol:json-array)))
                   (cons "positions" (quasar.protocol:empty-object))
                   (cons "viewport" :null)
                   (cons "layout" "cose")
                   (cons "selectedIds" (quasar.protocol:json-array))
                   (cons "groups" (quasar.protocol:empty-object)))
            (workspace-graph workspace graph-id) graph))
    graph))

(defun require-graph (workspace graph-id)
  (or (workspace-graph workspace graph-id)
      (error 'quasar.protocol:quasar-error
             :code "graph.not-found"
             :message (format nil "Graph ~A does not exist." graph-id))))

(defun generated-id (prefix)
  (format nil "~A:~36R:~36R" prefix (get-universal-time)
          (random most-positive-fixnum)))

(defun hash-table-values (table)
  (loop for value being the hash-values of table collect value))

(defun hash-table-object (table)
  (apply #'quasar.protocol:json-object
         (loop for key being the hash-keys of table
               using (hash-value value)
               collect (cons key (quasar.protocol:clone-json value)))))

(defun copy-workspace (source)
  "Return a deeply isolated copy of SOURCE suitable for candidate mutation."
  (let ((copy (make-instance 'workspace :id (workspace-id source))))
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

(defun clone-graph (graph)
  "Deep-clone a graph JSOWN object including nodes, edges, and all UI metadata."
  (quasar.protocol:clone-json graph))

(defun workspace-snapshot-with-documents (workspace documents)
  (quasar.protocol:json-object
   (cons "id" (workspace-id workspace))
   (cons "revision" (workspace-revision workspace))
   (cons "documents" (cons :array documents))
   (cons "graphs"
         (apply #'quasar.protocol:json-array
                (mapcar #'quasar.protocol:clone-json
                        (hash-table-values (workspace-graphs workspace)))))
   (cons "activeGraphId"
         (or (gethash "activeGraphId" (workspace-settings workspace))
             "all-documents"))
   (cons "settings" (hash-table-object (workspace-settings workspace)))))

(defun workspace-snapshot (workspace)
  (workspace-snapshot-with-documents
   workspace
   (mapcar #'quasar.protocol:clone-json
           (hash-table-values (workspace-documents workspace)))))

(defun workspace-snapshot-page (workspace offset byte-limit)
  "Return an authoritative snapshot with a size-bounded document page."
  (let* ((documents (hash-table-values (workspace-documents workspace)))
         (total (length documents))
         (page '())
         (page-bytes 0)
         (next-offset offset))
    (dolist (document (nthcdr offset documents))
      (let ((document-bytes
              (length (quasar.protocol:encode document))))
        (when (and page (> (+ page-bytes document-bytes) byte-limit))
          (return))
        (push (quasar.protocol:clone-json document) page)
        (incf page-bytes document-bytes)
        (incf next-offset)))
    (let ((snapshot (workspace-snapshot-with-documents workspace (nreverse page))))
      (quasar.protocol:object-set
       snapshot "documentPage"
       (quasar.protocol:json-object
        (cons "offset" offset)
        (cons "nextOffset" next-offset)
        (cons "total" total)
        (cons "complete" (>= next-offset total))))
      snapshot)))

(defun graph-snapshot (workspace graph-id)
  (let ((graph (workspace-graph workspace graph-id)))
    (unless graph
      (error 'quasar.protocol:quasar-error
             :code "graph.not-found"
             :message (format nil "Graph ~A does not exist." graph-id)))
    (clone-graph graph)))

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

(defun document-referenced-in-graphs-p (workspace document-id)
  "Return T if any graph node references this document."
  (loop for graph being the hash-values of (workspace-graphs workspace)
        thereis (let ((nodes (array-elements (graph-nodes graph))))
                  (find document-id nodes
                        :key (lambda (n) (quasar.protocol:json-value n "documentId"))
                        :test #'string=))))

(defun node-graphs-referencing-document (workspace document-id)
  (loop for graph-id being the hash-keys of (workspace-graphs workspace)
        using (hash-value graph)
        when (find document-id (array-elements (graph-nodes graph))
                   :key (lambda (node)
                          (quasar.protocol:json-value node "documentId"))
                   :test #'string=)
          collect graph-id))

(defun membership-graphs-referencing-document (workspace document-id)
  (loop for graph-id being the hash-keys of (workspace-graphs workspace)
        using (hash-value graph)
        for ids = (quasar.protocol:json-value graph "documentIds")
        when (and (consp ids)
                  (member document-id
                          (if (eq (car ids) :array) (rest ids) ids)
                          :test #'string=))
          collect graph-id))

(defun graphs-referencing-document (workspace document-id)
  "Return list of (graph-id . graph) pairs that reference document-id."
  (loop for graph-id being the hash-keys of (workspace-graphs workspace)
        using (hash-value graph)
        when (or (let ((nodes (array-elements (graph-nodes graph))))
                   (find document-id nodes
                         :key (lambda (n) (quasar.protocol:json-value n "documentId"))
                         :test #'string=))
                 (let ((ids (quasar.protocol:json-value graph "documentIds")))
                   (and (consp ids)
                        (member document-id
                                (if (eq (car ids) :array) (rest ids) ids)
                                :test #'string=))))
        collect (cons graph-id graph)))

(defun remove-node-from-graph (graph node-id)
  "Remove a node and all edges that reference it from a graph."
  (let ((nodes (graph-nodes graph))
        (edges (graph-edges graph)))
    (setf (rest nodes)
          (delete-if (lambda (n)
                       (string= (quasar.protocol:json-value n "id") node-id))
                     (rest nodes)))
    (setf (rest edges)
          (delete-if (lambda (e)
                       (or (string= (quasar.protocol:json-value e "source") node-id)
                           (string= (quasar.protocol:json-value e "target") node-id)))
                     (rest edges)))))

;;; --- Validation ---

(defun require-valid-document (workspace document)
  (declare (ignore workspace))
  (quasar.protocol:ensure-object document "document" "document.invalid")
  (quasar.protocol:ensure-string (quasar.protocol:json-value document "_id") "_id"
                                 "document.invalid")
  (let ((dtype (quasar.protocol:json-value document "dtype")))
    (unless (and dtype (stringp dtype) (plusp (length dtype)))
      (error 'quasar.protocol:quasar-error
             :code "document.invalid"
             :message "Document dtype must be a non-empty string.")))
  document)

(defun require-valid-node (workspace node)
  (quasar.protocol:ensure-object node "node" "document.invalid")
  (quasar.protocol:ensure-string (quasar.protocol:json-value node "id") "id"
                                 "document.invalid")
  (let ((doc-ref (quasar.protocol:json-value node "documentId")))
    (when doc-ref
      (quasar.protocol:ensure-string doc-ref "documentId" "graph.invalid-reference")
      (unless (gethash doc-ref (workspace-documents workspace))
        (error 'quasar.protocol:quasar-error
               :code "graph.invalid-reference"
               :message (format nil "Node references nonexistent document ~A." doc-ref)))))
  node)

(defun require-valid-edge (workspace edge graph)
  (quasar.protocol:ensure-object edge "edge" "graph.invalid-reference")
  (quasar.protocol:ensure-string (quasar.protocol:json-value edge "id") "id"
                                 "graph.invalid-reference")
  (let ((source (quasar.protocol:json-value edge "source"))
        (target (quasar.protocol:json-value edge "target"))
        (document-id (quasar.protocol:json-value edge "documentId")))
    (quasar.protocol:ensure-string source "source" "graph.invalid-reference")
    (quasar.protocol:ensure-string target "target" "graph.invalid-reference")
    (unless (graph-node graph source)
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid-reference"
             :message (format nil "Edge source ~A does not exist." source)))
    (unless (graph-node graph target)
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid-reference"
             :message (format nil "Edge target ~A does not exist." target)))
    (when document-id
      (quasar.protocol:ensure-string document-id "documentId" "graph.invalid-reference")
      (let ((document (gethash document-id (workspace-documents workspace))))
        (unless (and document
                     (string= (or (quasar.protocol:json-value document "dtype") "")
                              "relation"))
          (error 'quasar.protocol:quasar-error
                 :code "graph.invalid-reference"
                 :message (format nil "Edge references nonexistent relation document ~A."
                                  document-id))))))
  edge)

;;; --- Array helpers ---

(defun add-array-item (array item id-field error-code)
  (let ((items (rest array)))
    (when (find (quasar.protocol:json-value item id-field) items
                :key (lambda (n) (quasar.protocol:json-value n id-field))
                :test #'string=)
      (error 'quasar.protocol:quasar-error
             :code error-code
             :message (format nil "Duplicate id ~A."
                              (quasar.protocol:json-value item id-field))))
    (setf (rest array) (append items (list item))))
  item)

(defun replace-array-item (array item id-field not-found-code)
  (let* ((items (rest array))
         (id (quasar.protocol:json-value item id-field))
         (position (position id items
                            :key (lambda (n) (quasar.protocol:json-value n id-field))
                            :test #'string=)))
    (unless position
      (error 'quasar.protocol:quasar-error
             :code not-found-code
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

;;; --- Applied operation structure ---

(defstruct (applied-op
            (:constructor make-applied-op))
  event
  result
  inverse)

;;; --- Document operations ---

(defun apply-document-create (workspace payload)
  (quasar.protocol:ensure-object payload "document" "document.invalid")
  (let ((canonical (quasar.protocol:clone-json payload)))
    (unless (quasar.protocol:json-value canonical "_id")
      (quasar.protocol:object-set
       canonical "_id"
       (generated-id (or (quasar.protocol:json-value canonical "dtype") "document"))))
    (require-valid-document workspace canonical)
    (let ((id (quasar.protocol:json-value canonical "_id")))
      (when (gethash id (workspace-documents workspace))
        (error 'quasar.protocol:quasar-error
               :code "document.duplicate-id"
               :message (format nil "Document ~A already exists." id)))
      (setf (gethash id (workspace-documents workspace)) canonical)
      (make-applied-op
       :event "document.created"
       :result (quasar.protocol:json-object
                (cons "workspaceId" (workspace-id workspace))
                (cons "created" canonical)
                (cons "documentId" id))
       :inverse (quasar.protocol:json-object
                 (cons "type" "document.delete")
                 (cons "payload" (quasar.protocol:json-object (cons "id" id))))))))

(defun apply-document-update (workspace payload)
  (let ((id (quasar.protocol:json-value payload "_id")))
    (require-valid-document workspace payload)
    (let ((previous (require-document workspace id)))
      (let ((canonical (quasar.protocol:clone-json payload)))
        (setf (gethash id (workspace-documents workspace)) canonical)
        (make-applied-op
         :event "document.updated"
         :result (quasar.protocol:json-object
                  (cons "workspaceId" (workspace-id workspace))
                  (cons "updated" canonical)
                  (cons "documentId" id)
                  (cons "previous" (quasar.protocol:clone-json previous)))
         :inverse (quasar.protocol:json-object
                   (cons "type" "document.update")
                   (cons "payload" (quasar.protocol:clone-json previous))))))))

(defun apply-document-delete (workspace payload)
  (let ((id (quasar.protocol:ensure-string
              (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (let ((previous (require-document workspace id)))
      (let ((node-graphs (node-graphs-referencing-document workspace id))
            (membership-graphs
              (membership-graphs-referencing-document workspace id)))
        (when node-graphs
          (error 'quasar.protocol:quasar-error
                 :code "graph.invalid-reference"
                 :message (format nil "Document ~A is referenced by graph nodes; remove those nodes first."
                                  id)))
        (dolist (graph-id membership-graphs)
          (let* ((graph (workspace-graph workspace graph-id))
                 (ids (quasar.protocol:json-value graph "documentIds")))
            (quasar.protocol:object-set
             graph "documentIds"
             (apply #'quasar.protocol:json-array
                    (delete id (copy-list (array-elements ids)) :test #'string=)))))
        (remhash id (workspace-documents workspace))
        (make-applied-op
         :event "document.deleted"
         :result (quasar.protocol:json-object
                  (cons "workspaceId" (workspace-id workspace))
                  (cons "deleted" id)
                  (cons "documentId" id)
                  (cons "previous" (quasar.protocol:clone-json previous))
                  (cons "removedFromGraphs"
                        (apply #'quasar.protocol:json-array membership-graphs)))
         :inverse (quasar.protocol:json-object
                   (cons "type" "document.restore")
                   (cons "payload"
                         (quasar.protocol:json-object
                          (cons "document" (quasar.protocol:clone-json previous))
                          (cons "graphIds"
                                (apply #'quasar.protocol:json-array
                                       membership-graphs))))))))))

(defun apply-document-restore (workspace payload)
  (let* ((document (quasar.protocol:ensure-object
                    (quasar.protocol:json-value payload "document")
                    "document" "document.invalid"))
         (graph-ids (quasar.protocol:ensure-array
                     (quasar.protocol:json-value payload "graphIds")
                     "graphIds" "graph.invalid-reference"))
         (applied (apply-document-create workspace document))
         (document-id (quasar.protocol:json-value document "_id")))
    (dolist (graph-id (if (eq (car graph-ids) :array)
                          (rest graph-ids)
                          graph-ids))
      (let* ((graph (require-graph workspace graph-id))
             (ids (quasar.protocol:json-value graph "documentIds")))
        (when (eq ids :null)
          (error 'quasar.protocol:quasar-error
                 :code "graph.invalid-reference"
                 :message "All-documents membership cannot be restored explicitly."))
        (unless (member document-id (array-elements ids) :test #'string=)
          (quasar.protocol:object-set
           graph "documentIds"
           (apply #'quasar.protocol:json-array
                  (append (array-elements ids) (list document-id)))))))
    applied))

;;; --- Graph node operations ---

(defun apply-node-create (workspace payload)
  (let ((canonical (quasar.protocol:clone-json payload)))
    (unless (quasar.protocol:json-value canonical "id")
      (quasar.protocol:object-set
       canonical "id"
       (or (quasar.protocol:json-value canonical "documentId")
           (generated-id "node"))))
    (require-valid-node workspace canonical)
    (let* ((graph-id (or (quasar.protocol:json-value canonical "graphId") "default"))
           (graph (ensure-graph workspace graph-id))
           (nodes (graph-nodes graph)))
      (add-array-item nodes canonical "id" "graph.duplicate-id")
      (let ((document-ids (quasar.protocol:json-value graph "documentIds"))
            (document-id (quasar.protocol:json-value canonical "documentId")))
        (when (and document-ids document-id
                   (not (eq document-ids :null))
                   (not (member document-id (array-elements document-ids)
                                :test #'string=)))
          (quasar.protocol:object-set
           graph "documentIds"
           (apply #'quasar.protocol:json-array
                  (append (array-elements document-ids) (list document-id))))))
      (make-applied-op
       :event "graph.node.created"
       :result (quasar.protocol:json-object
                (cons "workspaceId" (workspace-id workspace))
                (cons "graphId" graph-id)
                (cons "created" canonical)
                (cons "nodeId" (quasar.protocol:json-value canonical "id")))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.node.delete")
                 (cons "payload" (quasar.protocol:json-object
                                  (cons "graphId" graph-id)
                                  (cons "id" (quasar.protocol:json-value canonical "id")))))))))

(defun apply-node-update (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (require-graph workspace graph-id))
         (node-id (quasar.protocol:ensure-string
                    (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (require-valid-node workspace payload)
    (let ((previous (require-graph-node graph node-id)))
      (let ((canonical (quasar.protocol:clone-json payload)))
        (replace-array-item (graph-nodes graph) canonical "id" "graph.node-not-found")
        (make-applied-op
         :event "graph.node.updated"
         :result (quasar.protocol:json-object
                  (cons "workspaceId" (workspace-id workspace))
                  (cons "graphId" graph-id)
                  (cons "updated" canonical)
                  (cons "nodeId" node-id)
                  (cons "previous" (quasar.protocol:clone-json previous)))
         :inverse (quasar.protocol:json-object
                   (cons "type" "graph.node.update")
                   (cons "payload" (quasar.protocol:clone-json previous))))))))

(defun apply-node-delete (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (require-graph workspace graph-id))
         (node-id (quasar.protocol:ensure-string
                    (quasar.protocol:json-value payload "id") "id" "document.invalid")))
    (let ((previous (require-graph-node graph node-id)))
      (let ((removed-edges (loop for e in (array-elements (graph-edges graph))
                                 when (or (string= (quasar.protocol:json-value e "source") node-id)
                                          (string= (quasar.protocol:json-value e "target") node-id))
                                 collect (quasar.protocol:clone-json e))))
        (remove-node-from-graph graph node-id)
        (let* ((document-id (quasar.protocol:json-value previous "documentId"))
               (document-ids (quasar.protocol:json-value graph "documentIds")))
          (when (and document-ids document-id)
            (setf (rest document-ids)
                  (delete document-id (rest document-ids) :test #'string=))))
        (make-applied-op
         :event "graph.node.deleted"
         :result (quasar.protocol:json-object
                  (cons "workspaceId" (workspace-id workspace))
                  (cons "graphId" graph-id)
                  (cons "deleted" node-id)
                  (cons "nodeId" node-id)
                  (cons "previous" (quasar.protocol:clone-json previous))
                  (cons "removedEdges" (apply #'quasar.protocol:json-array removed-edges)))
         :inverse (quasar.protocol:json-object
                   (cons "type" "graph.node.restore")
                   (cons "payload"
                         (quasar.protocol:json-object
                          (cons "node" (quasar.protocol:clone-json previous))
                          (cons "edges" (apply #'quasar.protocol:json-array
                                               removed-edges))))))))))

(defun apply-node-restore (workspace payload)
  (let* ((node (quasar.protocol:ensure-object
                (quasar.protocol:json-value payload "node") "node"
                "graph.invalid-reference"))
         (edges (quasar.protocol:ensure-array
                 (quasar.protocol:json-value payload "edges") "edges"
                 "graph.invalid-reference"))
         (applied (apply-node-create workspace node)))
    (dolist (edge (if (and (consp edges) (eq (car edges) :array))
                      (rest edges)
                      edges))
      (apply-edge-create workspace edge))
    applied))

;;; --- Graph workspace operations ---

(defun validate-graph-document-ids (workspace graph)
  (let ((document-ids (quasar.protocol:json-value graph "documentIds")))
    (unless (or (eq document-ids :null) (null document-ids)
                (quasar.protocol:array-p document-ids))
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid"
             :message "Graph documentIds must be an array or null."))
    (dolist (document-id (cond
                           ((or (eq document-ids :null) (null document-ids)) nil)
                           ((eq (car document-ids) :array) (rest document-ids))
                           (t document-ids)))
      (quasar.protocol:ensure-string document-id "documentId" "graph.invalid")
      (unless (gethash document-id (workspace-documents workspace))
        (error 'quasar.protocol:quasar-error
               :code "graph.invalid-reference"
               :message (format nil "Graph references nonexistent document ~A."
                                document-id))))))

(defun apply-graph-put (workspace payload)
  (quasar.protocol:ensure-object payload "graph" "graph.invalid")
  (let* ((id (quasar.protocol:ensure-string
              (quasar.protocol:json-value payload "id") "id" "graph.invalid"))
         (previous (workspace-graph workspace id))
         (canonical (quasar.protocol:clone-json payload)))
    ;; JSOWN parses both JSON null and an empty array as NIL. The graph ID
    ;; disambiguates the membership contract: all-documents is the null corpus
    ;; projection, while every named graph has an explicit array.
    (quasar.protocol:object-set
     canonical "documentIds"
     (if (string= id "all-documents")
         :null
         (or (quasar.protocol:json-value canonical "documentIds")
             (quasar.protocol:json-array))))
    (unless (quasar.protocol:json-value canonical "viewport")
      (quasar.protocol:object-set canonical "viewport" :null))
    (validate-graph-document-ids workspace canonical)
    (unless (quasar.protocol:json-value canonical "name")
      (quasar.protocol:object-set canonical "name" id))
    (unless (quasar.protocol:json-value canonical "nodes")
      (quasar.protocol:object-set canonical "nodes" (quasar.protocol:json-array)))
    (unless (quasar.protocol:json-value canonical "edges")
      (quasar.protocol:object-set canonical "edges" (quasar.protocol:json-array)))
    (let ((nodes (quasar.protocol:ensure-array
                  (quasar.protocol:json-value canonical "nodes")
                  "nodes" "graph.invalid"))
          (edges (quasar.protocol:ensure-array
                  (quasar.protocol:json-value canonical "edges")
                  "edges" "graph.invalid")))
      (quasar.protocol:object-set
       canonical "nodes"
       (apply #'quasar.protocol:json-array
              (mapcar #'quasar.protocol:clone-json (array-elements nodes))))
      (quasar.protocol:object-set
       canonical "edges"
       (apply #'quasar.protocol:json-array
              (mapcar #'quasar.protocol:clone-json (array-elements edges))))
      (let ((seen (make-hash-table :test #'equal)))
        (dolist (node (array-elements (graph-nodes canonical)))
          (require-valid-node workspace node)
          (let ((node-id (quasar.protocol:json-value node "id"))
                (node-graph-id (quasar.protocol:json-value node "graphId")))
            (when (gethash node-id seen)
              (error 'quasar.protocol:quasar-error
                     :code "graph.duplicate-id"
                     :message (format nil "Duplicate node id ~A." node-id)))
            (when (and node-graph-id (not (string= node-graph-id id)))
              (error 'quasar.protocol:quasar-error
                     :code "graph.invalid-reference"
                     :message (format nil "Node belongs to graph ~A, not ~A."
                                      node-graph-id id)))
            (setf (gethash node-id seen) t))))
      (let ((seen (make-hash-table :test #'equal)))
        (dolist (edge (array-elements (graph-edges canonical)))
          (require-valid-edge workspace edge canonical)
          (let ((edge-id (quasar.protocol:json-value edge "id"))
                (edge-graph-id (quasar.protocol:json-value edge "graphId")))
            (when (gethash edge-id seen)
              (error 'quasar.protocol:quasar-error
                     :code "graph.duplicate-id"
                     :message (format nil "Duplicate edge id ~A." edge-id)))
            (when (and edge-graph-id (not (string= edge-graph-id id)))
              (error 'quasar.protocol:quasar-error
                     :code "graph.invalid-reference"
                     :message (format nil "Edge belongs to graph ~A, not ~A."
                                      edge-graph-id id)))
            (setf (gethash edge-id seen) t)))))
    (setf (workspace-graph workspace id) canonical)
    (make-applied-op
     :event (if previous "graph.updated" "graph.created")
     :result (quasar.protocol:json-object
              (cons "workspaceId" (workspace-id workspace))
              (cons (if previous "updated" "created") canonical)
              (cons "graphId" id)
              (cons "previous" (and previous (quasar.protocol:clone-json previous))))
     :inverse (if previous
                  (quasar.protocol:json-object
                   (cons "type" "graph.put")
                   (cons "payload" (quasar.protocol:clone-json previous)))
                  (quasar.protocol:json-object
                   (cons "type" "graph.delete")
                   (cons "payload" (quasar.protocol:json-object
                                    (cons "id" id))))))))

(defun apply-graph-delete (workspace payload)
  (let* ((id (quasar.protocol:ensure-string
              (quasar.protocol:json-value payload "id") "id" "graph.invalid"))
         (previous (workspace-graph workspace id)))
    (unless previous
      (error 'quasar.protocol:quasar-error
             :code "graph.not-found"
             :message (format nil "Graph ~A does not exist." id)))
    (when (= (hash-table-count (workspace-graphs workspace)) 1)
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid"
             :message "The final graph cannot be deleted."))
    (remhash id (workspace-graphs workspace))
    (when (string= id (gethash "activeGraphId" (workspace-settings workspace)))
      (setf (gethash "activeGraphId" (workspace-settings workspace))
            (loop for graph-id being the hash-keys of (workspace-graphs workspace)
                  do (return graph-id))))
    (make-applied-op
     :event "graph.deleted"
     :result (quasar.protocol:json-object
              (cons "workspaceId" (workspace-id workspace))
              (cons "graphId" id)
              (cons "deleted" id)
              (cons "previous" (quasar.protocol:clone-json previous)))
     :inverse (quasar.protocol:json-object
               (cons "type" "graph.put")
               (cons "payload" (quasar.protocol:clone-json previous))))))

(defun apply-graph-activate (workspace payload)
  (let ((id (quasar.protocol:ensure-string
             (quasar.protocol:json-value payload "id") "id" "graph.invalid")))
    (unless (workspace-graph workspace id)
      (error 'quasar.protocol:quasar-error
             :code "graph.not-found"
             :message (format nil "Graph ~A does not exist." id)))
    (let ((previous (gethash "activeGraphId" (workspace-settings workspace))))
      (setf (gethash "activeGraphId" (workspace-settings workspace)) id)
      (make-applied-op
       :event "graph.activated"
       :result (quasar.protocol:json-object
                (cons "workspaceId" (workspace-id workspace))
                (cons "activeGraphId" id)
                (cons "previous" previous))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.activate")
                 (cons "payload" (quasar.protocol:json-object
                                  (cons "id" previous))))))))

;;; --- Graph edge operations ---

(defun apply-edge-create (workspace payload)
  (let ((canonical (quasar.protocol:clone-json payload)))
    (unless (quasar.protocol:json-value canonical "id")
      (quasar.protocol:object-set
       canonical "id"
       (or (quasar.protocol:json-value canonical "documentId")
           (generated-id "edge"))))
    (let* ((graph-id (or (quasar.protocol:json-value canonical "graphId") "default"))
           (graph (ensure-graph workspace graph-id)))
      (require-valid-edge workspace canonical graph)
      (add-array-item (graph-edges graph) canonical "id" "graph.duplicate-id")
      (make-applied-op
       :event "graph.edge.created"
       :result (quasar.protocol:json-object
                (cons "workspaceId" (workspace-id workspace))
                (cons "graphId" graph-id)
                (cons "created" canonical)
                (cons "edgeId" (quasar.protocol:json-value canonical "id")))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.edge.delete")
                 (cons "payload" (quasar.protocol:json-object
                                  (cons "graphId" graph-id)
                                  (cons "id" (quasar.protocol:json-value canonical "id")))))))))

(defun apply-edge-update (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (require-graph workspace graph-id))
         (edge-id (quasar.protocol:ensure-string
                    (quasar.protocol:json-value payload "id") "id" "graph.invalid-reference")))
    (require-valid-edge workspace payload graph)
    (let ((previous (require-graph-edge graph edge-id)))
      (let ((canonical (quasar.protocol:clone-json payload)))
        (replace-array-item (graph-edges graph) canonical "id" "graph.edge-not-found")
        (make-applied-op
         :event "graph.edge.updated"
         :result (quasar.protocol:json-object
                  (cons "workspaceId" (workspace-id workspace))
                  (cons "graphId" graph-id)
                  (cons "updated" canonical)
                  (cons "edgeId" edge-id)
                  (cons "previous" (quasar.protocol:clone-json previous)))
         :inverse (quasar.protocol:json-object
                   (cons "type" "graph.edge.update")
                   (cons "payload" (quasar.protocol:clone-json previous))))))))

(defun apply-edge-delete (workspace payload)
  (let* ((graph-id (or (quasar.protocol:json-value payload "graphId") "default"))
         (graph (require-graph workspace graph-id))
         (edge-id (quasar.protocol:ensure-string
                    (quasar.protocol:json-value payload "id") "id" "graph.invalid-reference")))
    (let ((previous (require-graph-edge graph edge-id)))
      (remove-array-item (graph-edges graph) edge-id "id"
                         "graph.edge-not-found"
                         (format nil "Edge ~A does not exist." edge-id))
      (make-applied-op
       :event "graph.edge.deleted"
       :result (quasar.protocol:json-object
                (cons "workspaceId" (workspace-id workspace))
                (cons "graphId" graph-id)
                (cons "deleted" edge-id)
                (cons "edgeId" edge-id)
                (cons "previous" (quasar.protocol:clone-json previous)))
       :inverse (quasar.protocol:json-object
                 (cons "type" "graph.edge.create")
                 (cons "payload" (quasar.protocol:clone-json previous)))))))

;;; --- Dispatch ---

(defun dispatch-operation (workspace operation)
  (let ((type (quasar.protocol:json-value operation "type"))
        (payload (or (quasar.protocol:json-value operation "payload")
                     (quasar.protocol:empty-object))))
    (cond
      ((string= type "document.create")
       (apply-document-create workspace payload))
      ((string= type "document.update")
       (apply-document-update workspace payload))
      ((string= type "document.delete")
       (apply-document-delete workspace payload))
      ((string= type "document.restore")
       (apply-document-restore workspace payload))
      ((string= type "graph.node.create")
       (apply-node-create workspace payload))
      ((string= type "graph.node.update")
       (apply-node-update workspace payload))
      ((string= type "graph.node.delete")
       (apply-node-delete workspace payload))
      ((string= type "graph.node.restore")
       (apply-node-restore workspace payload))
      ((string= type "graph.edge.create")
       (apply-edge-create workspace payload))
      ((string= type "graph.edge.update")
       (apply-edge-update workspace payload))
      ((string= type "graph.edge.delete")
       (apply-edge-delete workspace payload))
      ((string= type "graph.put")
       (apply-graph-put workspace payload))
      ((string= type "graph.delete")
       (apply-graph-delete workspace payload))
      ((string= type "graph.activate")
       (apply-graph-activate workspace payload))
      (t
       (error 'quasar.protocol:quasar-error
              :code "protocol.unknown-command"
              :message (format nil "Unknown operation type ~S." type))))))

(defun commit-operations (workspace operations)
  "Apply every operation, collecting events and inverses. Signals on the first
failure and leaves WORKSPACE unchanged (caller is responsible for using a
candidate copy for transaction isolation)."
  (let ((applied-operations '())
        (inverses '()))
    (dolist (operation operations)
      (let ((applied (dispatch-operation workspace operation)))
        (push applied applied-operations)
        (push (applied-op-inverse applied) inverses)))
    (values (nreverse applied-operations) inverses)))
