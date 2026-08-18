(in-package #:quasar.control-plane)

(defun mutation-context-load-edge-dependencies (context edge)
  (let ((graph-id
          (or (quasar.protocol:json-value edge "graphId") "default"))
        (source (quasar.protocol:json-value edge "source"))
        (target (quasar.protocol:json-value edge "target"))
        (document-id (quasar.protocol:json-value edge "documentId")))
    (mutation-context-graph context graph-id)
    (when source
      (mutation-context-node context graph-id source))
    (when target
      (mutation-context-node context graph-id target))
    (when document-id
      (mutation-context-document context document-id)))
  context)

(defun mutation-context-prepare-graph-put (context payload)
  (let ((graph-id (quasar.protocol:json-value payload "id")))
    (when graph-id
      (mutation-context-promote-graph-to-full context graph-id))
    (let ((document-ids (quasar.protocol:json-value payload "documentIds")))
      (when (and (consp document-ids) (not (eq document-ids :null)))
        (dolist (document-id (quasar.workspace:array-elements document-ids))
          (mutation-context-document context document-id))))
    (dolist
        (node
         (quasar.workspace:array-elements
          (or
           (quasar.protocol:json-value payload "nodes")
           (quasar.protocol:json-array))))
      (let ((document-id (quasar.protocol:json-value node "documentId")))
        (when document-id
          (mutation-context-document context document-id))))
    (dolist
        (edge
         (quasar.workspace:array-elements
          (or
           (quasar.protocol:json-value payload "edges")
           (quasar.protocol:json-array))))
      (let ((document-id (quasar.protocol:json-value edge "documentId")))
        (when document-id
          (mutation-context-document context document-id)))))
  context)

(defun mutation-context-prepare-operation (context operation)
  (let* ((type (quasar.protocol:json-value operation "type"))
         (payload
           (or
            (quasar.protocol:json-value operation "payload")
            (quasar.protocol:empty-object))))
    (cond
      ((string= type "document.create")
       (let ((id (quasar.protocol:json-value payload "_id")))
         (when id
           (mutation-context-document context id))))
      ((string= type "document.update")
       (let ((id (quasar.protocol:json-value payload "_id")))
         (when id
           (mutation-context-document context id)
           (unless
               (string=
                (or (quasar.protocol:json-value payload "dtype") "")
                "relation")
             (mutation-context-load-document-edge-references context id)))))
      ((string= type "document.delete")
       (let ((id (quasar.protocol:json-value payload "id")))
         (when id
           (mutation-context-document context id)
           (mutation-context-load-document-node-references context id)
           (mutation-context-load-document-memberships context id))))
      ((string= type "document.restore")
       (let* ((document (quasar.protocol:json-value payload "document"))
              (id (and document (quasar.protocol:json-value document "_id"))))
         (when id
           (mutation-context-document context id))
         (dolist
             (graph-id
              (quasar.workspace:array-elements
               (or
                (quasar.protocol:json-value payload "graphIds")
                (quasar.protocol:json-array))))
           (mutation-context-graph context graph-id))))
      ((string= type "graph.node.create")
       (let* ((graph-id
                (or (quasar.protocol:json-value payload "graphId") "default"))
              (node-id
                (or
                 (quasar.protocol:json-value payload "id")
                 (quasar.protocol:json-value payload "documentId")))
              (document-id (quasar.protocol:json-value payload "documentId")))
         (mutation-context-graph context graph-id)
         (when node-id
           (mutation-context-node context graph-id node-id))
         (when document-id
           (mutation-context-document context document-id))))
      ((string= type "graph.node.update")
       (let* ((graph-id
                (or (quasar.protocol:json-value payload "graphId") "default"))
              (node-id (quasar.protocol:json-value payload "id"))
              (previous
                (and node-id
                     (mutation-context-node context graph-id node-id)))
              (previous-document-id
                (and previous
                     (quasar.protocol:json-value previous "documentId")))
              (document-id (quasar.protocol:json-value payload "documentId")))
         (when previous-document-id
           (mutation-context-load-graph-document-nodes
            context graph-id previous-document-id))
         (when document-id
           (mutation-context-document context document-id))))
      ((string= type "graph.node.delete")
       (let* ((graph-id
                (or (quasar.protocol:json-value payload "graphId") "default"))
              (node-id (quasar.protocol:json-value payload "id"))
              (previous
                (and node-id
                     (mutation-context-node context graph-id node-id)))
              (document-id
                (and previous
                     (quasar.protocol:json-value previous "documentId"))))
         (when node-id
           (mutation-context-load-incident-edges context graph-id node-id))
         (when document-id
           (mutation-context-load-graph-document-nodes
            context graph-id document-id))))
      ((string= type "graph.node.restore")
       (let ((node (quasar.protocol:json-value payload "node")))
         (when node
           (mutation-context-prepare-operation
            context
            (quasar.protocol:json-object
             (cons "type" "graph.node.create")
             (cons "payload" node))))
         (dolist
             (edge
              (quasar.workspace:array-elements
               (or
                (quasar.protocol:json-value payload "edges")
                (quasar.protocol:json-array))))
           (mutation-context-load-edge-dependencies context edge))))
      ((string= type "graph.edge.create")
       (let* ((graph-id
                (or (quasar.protocol:json-value payload "graphId") "default"))
              (edge-id
                (or
                 (quasar.protocol:json-value payload "id")
                 (quasar.protocol:json-value payload "documentId"))))
         (mutation-context-load-edge-dependencies context payload)
         (when edge-id
           (mutation-context-edge context graph-id edge-id))))
      ((string= type "graph.edge.update")
       (let* ((graph-id
                (or (quasar.protocol:json-value payload "graphId") "default"))
              (edge-id (quasar.protocol:json-value payload "id")))
         (mutation-context-load-edge-dependencies context payload)
         (when edge-id
           (mutation-context-edge context graph-id edge-id))))
      ((string= type "graph.edge.delete")
       (let* ((graph-id
                (or (quasar.protocol:json-value payload "graphId") "default"))
              (edge-id (quasar.protocol:json-value payload "id")))
         (mutation-context-graph context graph-id)
         (when edge-id
           (mutation-context-edge context graph-id edge-id))))
      ((string= type "graph.put")
       (mutation-context-prepare-graph-put context payload))
      ((string= type "graph.delete")
       (let ((graph-id (quasar.protocol:json-value payload "id")))
         (when graph-id
           (mutation-context-promote-graph-to-full context graph-id)
           (when
               (> (quasar.store:direct-graph-count
                   (mutation-context-store context)
                   (mutation-context-workspace-id context))
                  1)
             (let ((other
                     (quasar.store:direct-other-graph-metadata
                      (mutation-context-store context)
                      (mutation-context-workspace-id context)
                      graph-id)))
               (when other
                 (let ((other-id
                         (quasar.protocol:json-value other "id")))
                   (unless
                       (quasar.workspace:workspace-graph
                        (mutation-context-workspace context)
                        other-id)
                     (setf
                      (quasar.workspace:workspace-graph
                       (mutation-context-workspace context)
                       other-id)
                      (mutation-graph-object-from-metadata other)
                      (gethash
                       other-id
                       (mutation-context-graph-state context))
                      :partial)))))))))
      ((string= type "graph.activate")
       (let ((graph-id (quasar.protocol:json-value payload "id")))
         (when graph-id
           (mutation-context-graph context graph-id))))
      (t nil)))
  context)

(defun mutation-context-track-operation (context operation applied)
  (let* ((type (quasar.protocol:json-value operation "type"))
         (result (quasar.workspace:applied-op-result applied)))
    (cond
      ((member
        type
        '("document.create" "document.update" "document.restore")
        :test #'string=)
       (let ((id (quasar.protocol:json-value result "documentId")))
         (when id
           (setf
            (gethash id (mutation-context-document-state context))
            :present))))
      ((string= type "document.delete")
       (let ((id (quasar.protocol:json-value result "documentId")))
         (when id
           (setf
            (gethash id (mutation-context-document-state context))
            :deleted))))
      ((member
        type
        '("graph.node.create" "graph.node.update" "graph.node.restore")
        :test #'string=)
       (let ((graph-id (quasar.protocol:json-value result "graphId"))
             (node-id (quasar.protocol:json-value result "nodeId")))
         (when graph-id
           (unless
               (member
                (gethash graph-id (mutation-context-graph-state context))
                '(:replaced :full)
                :test #'eq)
             (setf
              (gethash graph-id (mutation-context-graph-state context))
              :partial)))
         (when (and graph-id node-id)
           (setf
            (gethash
             (mutation-record-key graph-id node-id)
             (mutation-context-node-state context))
            :present))))
      ((string= type "graph.node.delete")
       (let ((graph-id (quasar.protocol:json-value result "graphId"))
             (node-id (quasar.protocol:json-value result "nodeId")))
         (when (and graph-id node-id)
           (setf
            (gethash
             (mutation-record-key graph-id node-id)
             (mutation-context-node-state context))
            :deleted))
         (dolist
             (edge
              (quasar.workspace:array-elements
               (or
                (quasar.protocol:json-value result "removedEdges")
                (quasar.protocol:json-array))))
           (let ((edge-id (quasar.protocol:json-value edge "id")))
             (when (and graph-id edge-id)
               (setf
                (gethash
                 (mutation-record-key graph-id edge-id)
                 (mutation-context-edge-state context))
                :deleted))))))
      ((member
        type
        '("graph.edge.create" "graph.edge.update")
        :test #'string=)
       (let ((graph-id (quasar.protocol:json-value result "graphId"))
             (edge-id (quasar.protocol:json-value result "edgeId")))
         (when (and graph-id edge-id)
           (setf
            (gethash
             (mutation-record-key graph-id edge-id)
             (mutation-context-edge-state context))
            :present))))
      ((string= type "graph.edge.delete")
       (let ((graph-id (quasar.protocol:json-value result "graphId"))
             (edge-id (quasar.protocol:json-value result "edgeId")))
         (when (and graph-id edge-id)
           (setf
            (gethash
             (mutation-record-key graph-id edge-id)
             (mutation-context-edge-state context))
            :deleted))))
      ((string= type "graph.put")
       (let ((graph-id (quasar.protocol:json-value result "graphId")))
         (when graph-id
           (setf
            (gethash graph-id (mutation-context-graph-state context))
            :replaced))))
      ((string= type "graph.delete")
       (let ((graph-id (quasar.protocol:json-value result "graphId")))
         (when graph-id
           (setf
            (gethash graph-id (mutation-context-graph-state context))
            :deleted))))
      ((string= type "graph.activate")
       nil)))
  applied)

(defun mutation-context-apply-operation (context operation)
  (mutation-context-prepare-operation context operation)
  (let ((applied
          (quasar.workspace:dispatch-operation
           (mutation-context-workspace context)
           operation)))
    (mutation-context-track-operation context operation applied)
    applied))
