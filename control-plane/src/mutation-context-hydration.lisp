(in-package #:quasar.control-plane)

(defun mutation-context-overlay-authoritative-graph-p (context graph-id)
  (member
   (gethash graph-id (mutation-context-graph-state context))
   '(:new :replaced :deleted :full)
   :test #'eq))

(defun mutation-context-load-document-node-references (context document-id)
  (dolist
      (entry
       (quasar.store:direct-document-node-references
        (mutation-context-store context)
        (mutation-context-workspace-id context)
        document-id))
    (let* ((graph-id (car entry))
           (node (cdr entry))
           (node-id (quasar.protocol:json-value node "id"))
           (key (mutation-record-key graph-id node-id))
           (state (gethash key (mutation-context-node-state context)))
           (graph
             (quasar.workspace:workspace-graph
              (mutation-context-workspace context) graph-id))
           (overlay-node
             (and graph (quasar.workspace:graph-node graph node-id))))
      (unless
          (or
           (eq state :deleted)
           (mutation-context-overlay-authoritative-graph-p context graph-id)
           overlay-node)
        (mutation-context-install-node context graph-id node))))
  context)

(defun mutation-context-load-document-edge-references (context document-id)
  (dolist
      (entry
       (quasar.store:direct-document-edge-references
        (mutation-context-store context)
        (mutation-context-workspace-id context)
        document-id))
    (let* ((graph-id (car entry))
           (edge (cdr entry))
           (edge-id (quasar.protocol:json-value edge "id"))
           (key (mutation-record-key graph-id edge-id))
           (state (gethash key (mutation-context-edge-state context)))
           (graph
             (quasar.workspace:workspace-graph
              (mutation-context-workspace context) graph-id))
           (overlay-edge
             (and graph (quasar.workspace:graph-edge graph edge-id))))
      (unless
          (or
           (eq state :deleted)
           (mutation-context-overlay-authoritative-graph-p context graph-id)
           overlay-edge)
        (mutation-context-install-edge context graph-id edge))))
  context)

(defun mutation-context-load-document-memberships (context document-id)
  (dolist
      (metadata
       (quasar.store:direct-document-memberships
        (mutation-context-store context)
        (mutation-context-workspace-id context)
        document-id))
    (let* ((graph-id (quasar.protocol:json-value metadata "id"))
           (known
             (quasar.workspace:workspace-graph
              (mutation-context-workspace context) graph-id)))
      (unless
          (or
           known
           (member
            (gethash graph-id (mutation-context-graph-state context))
            '(:new :replaced :deleted :full)
            :test #'eq))
        (let ((graph (mutation-graph-object-from-metadata metadata)))
          (setf
           (quasar.workspace:workspace-graph
            (mutation-context-workspace context) graph-id)
           graph
           (gethash graph-id (mutation-context-graph-state context))
           :partial)))))
  context)

(defun mutation-context-load-graph-document-nodes
    (context graph-id document-id)
  (unless (mutation-context-overlay-authoritative-graph-p context graph-id)
    (dolist
        (node
         (quasar.store:direct-graph-nodes-referencing-document
          (mutation-context-store context)
          (mutation-context-workspace-id context)
          graph-id
          document-id))
      (let* ((node-id (quasar.protocol:json-value node "id"))
             (key (mutation-record-key graph-id node-id))
             (state (gethash key (mutation-context-node-state context)))
             (graph
               (quasar.workspace:workspace-graph
                (mutation-context-workspace context) graph-id))
             (overlay-node
               (and graph (quasar.workspace:graph-node graph node-id))))
        (unless (or (eq state :deleted) overlay-node)
          (mutation-context-install-node context graph-id node)))))
  context)

(defun mutation-context-load-incident-edges (context graph-id node-id)
  (unless (mutation-context-overlay-authoritative-graph-p context graph-id)
    (dolist
        (edge
         (quasar.store:direct-graph-incident-edges
          (mutation-context-store context)
          (mutation-context-workspace-id context)
          graph-id
          node-id))
      (let* ((edge-id (quasar.protocol:json-value edge "id"))
             (state
               (gethash
                (mutation-record-key graph-id edge-id)
                (mutation-context-edge-state context))))
        (unless (eq state :deleted)
          (mutation-context-install-edge context graph-id edge)))))
  context)

(defun mutation-context-merge-record-array
    (base-array overlay-array state-table graph-id id-field)
  (let ((records (make-hash-table :test #'equal))
        (order nil))
    (dolist (record (quasar.workspace:array-elements base-array))
      (let ((id (quasar.protocol:json-value record id-field)))
        (unless
            (eq
             :deleted
             (gethash
              (mutation-record-key graph-id id)
              state-table))
          (setf (gethash id records) (quasar.protocol:clone-json record))
          (push id order))))
    (dolist (record (quasar.workspace:array-elements overlay-array))
      (let ((id (quasar.protocol:json-value record id-field)))
        (unless (gethash id records)
          (push id order))
        (setf (gethash id records) (quasar.protocol:clone-json record))))
    (apply
     #'quasar.protocol:json-array
     (loop
       for id in (nreverse order)
       for record = (gethash id records)
       when record collect record))))

(defun mutation-context-promote-graph-to-full (context graph-id)
  (let* ((workspace (mutation-context-workspace context))
         (current (quasar.workspace:workspace-graph workspace graph-id))
         (state (gethash graph-id (mutation-context-graph-state context))))
    (when (member state '(:new :replaced :full) :test #'eq)
      (return-from mutation-context-promote-graph-to-full current))
    (when (member state '(:absent :deleted) :test #'eq)
      (return-from mutation-context-promote-graph-to-full nil))
    (let ((base
            (quasar.store:direct-mutation-graph
             (mutation-context-store context)
             (mutation-context-workspace-id context)
             graph-id)))
      (unless base
        (setf
         (gethash graph-id (mutation-context-graph-state context))
         :absent)
        (return-from mutation-context-promote-graph-to-full nil))
      (let ((merged
              (if current
                  (let ((graph (quasar.protocol:clone-json current)))
                    (quasar.protocol:object-set
                     graph
                     "nodes"
                     (mutation-context-merge-record-array
                      (quasar.workspace:graph-nodes base)
                      (quasar.workspace:graph-nodes current)
                      (mutation-context-node-state context)
                      graph-id
                      "id"))
                    (quasar.protocol:object-set
                     graph
                     "edges"
                     (mutation-context-merge-record-array
                      (quasar.workspace:graph-edges base)
                      (quasar.workspace:graph-edges current)
                      (mutation-context-edge-state context)
                      graph-id
                      "id"))
                    graph)
                  base)))
        (setf
         (quasar.workspace:workspace-graph workspace graph-id) merged
         (gethash graph-id (mutation-context-graph-state context))
         :full)
        merged))))
