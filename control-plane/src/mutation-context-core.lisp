(in-package #:quasar.control-plane)

(defparameter +mutation-max-operations+ 1000)

(defstruct (mutation-context
            (:constructor %make-mutation-context))
  store
  workspace
  workspace-id
  base-revision
  (document-state (make-hash-table :test #'equal))
  (graph-state (make-hash-table :test #'equal))
  (node-state (make-hash-table :test #'equal))
  (edge-state (make-hash-table :test #'equal)))

(defun mutation-record-key (graph-id record-id)
  (list graph-id record-id))

(defun mutation-context-settings-json (context)
  (apply
   #'quasar.protocol:json-object
   (loop
     for key being the hash-keys
       of (quasar.workspace:workspace-settings
           (mutation-context-workspace context))
     using (hash-value value)
     collect
       (cons key (quasar.protocol:clone-json value)))))

(defun mutation-context-restore-settings (workspace metadata)
  (let ((settings
          (or
           (quasar.protocol:json-value metadata "settings")
           (quasar.protocol:empty-object))))
    (clrhash (quasar.workspace:workspace-settings workspace))
    (when (quasar.protocol:object-p settings)
      (dolist (pair (rest settings))
        (setf
         (gethash
          (car pair)
          (quasar.workspace:workspace-settings workspace))
         (quasar.protocol:clone-json (cdr pair)))))
    (unless
        (gethash
         "activeGraphId"
         (quasar.workspace:workspace-settings workspace))
      (setf
       (gethash
        "activeGraphId"
        (quasar.workspace:workspace-settings workspace))
       (or
        (quasar.protocol:json-value metadata "activeGraphId")
        "all-documents"))))
  workspace)

(defun make-record-mutation-context (store workspace-id)
  (let* ((metadata
           (quasar.store:direct-workspace-metadata store workspace-id))
         (revision
           (or (quasar.protocol:json-value metadata "revision") 0))
         (workspace
           (make-instance
            'quasar.workspace:persistent-workspace
            :id workspace-id)))
    (setf (quasar.workspace:workspace-revision workspace) revision)
    (mutation-context-restore-settings workspace metadata)
    (%make-mutation-context
     :store store
     :workspace workspace
     :workspace-id workspace-id
     :base-revision revision)))

(defun mutation-graph-object-from-metadata (metadata)
  (when metadata
    (let ((graph (quasar.protocol:clone-json metadata)))
      (quasar.protocol:object-set graph "nodes" (quasar.protocol:json-array))
      (quasar.protocol:object-set graph "edges" (quasar.protocol:json-array))
      graph)))

(defun mutation-context-document (context document-id)
  (let* ((workspace (mutation-context-workspace context))
         (documents (quasar.workspace:workspace-documents workspace))
         (present (gethash document-id documents)))
    (when present
      (return-from mutation-context-document present))
    (multiple-value-bind (state known-p)
        (gethash document-id (mutation-context-document-state context))
      (when known-p
        (return-from mutation-context-document
          (and (eq state :present)
               (gethash document-id documents)))))
    (let ((document
            (quasar.store:direct-document
             (mutation-context-store context)
             (mutation-context-workspace-id context)
             document-id)))
      (if document
          (progn
            (setf
             (gethash document-id documents) document
             (gethash
              document-id
              (mutation-context-document-state context))
             :present)
            document)
          (progn
            (setf
             (gethash
              document-id
              (mutation-context-document-state context))
             :absent)
            nil)))))

(defun mutation-context-graph (context graph-id)
  (let* ((workspace (mutation-context-workspace context))
         (graph (quasar.workspace:workspace-graph workspace graph-id)))
    (when graph
      (return-from mutation-context-graph graph))
    (multiple-value-bind (state known-p)
        (gethash graph-id (mutation-context-graph-state context))
      (when (and known-p (member state '(:absent :deleted) :test #'eq))
        (return-from mutation-context-graph nil)))
    (let ((metadata
            (quasar.store:direct-graph-metadata
             (mutation-context-store context)
             (mutation-context-workspace-id context)
             graph-id)))
      (if metadata
          (let ((loaded (mutation-graph-object-from-metadata metadata)))
            (setf
             (quasar.workspace:workspace-graph workspace graph-id) loaded
             (gethash graph-id (mutation-context-graph-state context))
             :partial)
            loaded)
          (progn
            (setf
             (gethash graph-id (mutation-context-graph-state context))
             :absent)
            nil)))))

(defun mutation-context-install-node (context graph-id node)
  (let* ((graph
           (or
            (mutation-context-graph context graph-id)
            (return-from mutation-context-install-node nil)))
         (node-id (quasar.protocol:json-value node "id")))
    (unless (quasar.workspace:graph-node graph node-id)
      (setf
       (rest (quasar.workspace:graph-nodes graph))
       (append
        (rest (quasar.workspace:graph-nodes graph))
        (list (quasar.protocol:clone-json node)))))
    (setf
     (gethash
      (mutation-record-key graph-id node-id)
      (mutation-context-node-state context))
     :present)
    (quasar.workspace:graph-node graph node-id)))

(defun mutation-context-install-edge (context graph-id edge)
  (let* ((graph
           (or
            (mutation-context-graph context graph-id)
            (return-from mutation-context-install-edge nil)))
         (edge-id (quasar.protocol:json-value edge "id")))
    (unless (quasar.workspace:graph-edge graph edge-id)
      (setf
       (rest (quasar.workspace:graph-edges graph))
       (append
        (rest (quasar.workspace:graph-edges graph))
        (list (quasar.protocol:clone-json edge)))))
    (setf
     (gethash
      (mutation-record-key graph-id edge-id)
      (mutation-context-edge-state context))
     :present)
    (quasar.workspace:graph-edge graph edge-id)))

(defun mutation-context-node (context graph-id node-id)
  (let* ((workspace (mutation-context-workspace context))
         (graph (quasar.workspace:workspace-graph workspace graph-id))
         (staged (and graph (quasar.workspace:graph-node graph node-id))))
    (when staged
      (return-from mutation-context-node staged))
    (let ((graph-state
            (gethash graph-id (mutation-context-graph-state context))))
      (when (member graph-state '(:new :replaced :deleted :full) :test #'eq)
        (return-from mutation-context-node nil)))
    (multiple-value-bind (state known-p)
        (gethash
         (mutation-record-key graph-id node-id)
         (mutation-context-node-state context))
      (when (and known-p (member state '(:absent :deleted) :test #'eq))
        (return-from mutation-context-node nil)))
    (unless (mutation-context-graph context graph-id)
      (return-from mutation-context-node nil))
    (let ((node
            (quasar.store:direct-graph-node
             (mutation-context-store context)
             (mutation-context-workspace-id context)
             graph-id
             node-id)))
      (if node
          (mutation-context-install-node context graph-id node)
          (progn
            (setf
             (gethash
              (mutation-record-key graph-id node-id)
              (mutation-context-node-state context))
             :absent)
            nil)))))

(defun mutation-context-edge (context graph-id edge-id)
  (let* ((workspace (mutation-context-workspace context))
         (graph (quasar.workspace:workspace-graph workspace graph-id))
         (staged (and graph (quasar.workspace:graph-edge graph edge-id))))
    (when staged
      (return-from mutation-context-edge staged))
    (let ((graph-state
            (gethash graph-id (mutation-context-graph-state context))))
      (when (member graph-state '(:new :replaced :deleted :full) :test #'eq)
        (return-from mutation-context-edge nil)))
    (multiple-value-bind (state known-p)
        (gethash
         (mutation-record-key graph-id edge-id)
         (mutation-context-edge-state context))
      (when (and known-p (member state '(:absent :deleted) :test #'eq))
        (return-from mutation-context-edge nil)))
    (unless (mutation-context-graph context graph-id)
      (return-from mutation-context-edge nil))
    (let ((edge
            (quasar.store:direct-graph-edge
             (mutation-context-store context)
             (mutation-context-workspace-id context)
             graph-id
             edge-id)))
      (if edge
          (mutation-context-install-edge context graph-id edge)
          (progn
            (setf
             (gethash
              (mutation-record-key graph-id edge-id)
              (mutation-context-edge-state context))
             :absent)
            nil)))))
