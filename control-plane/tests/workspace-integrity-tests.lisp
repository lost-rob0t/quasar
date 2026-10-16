(in-package #:quasar.tests)

(defun graph-document-ids-for-test (workspace graph-id)
  (let ((ids (quasar.protocol:json-value
              (workspace-graph workspace graph-id)
              "documentIds")))
    (if (and (consp ids) (eq (car ids) :array))
        (rest ids)
        ids)))

(defun test-all-documents-node-delete-preserves-null-membership ()
  (let ((workspace (make-workspace :id "all-documents-delete")))
    (apply-document-create workspace (make-doc "person:all"))
    (apply-node-create workspace (make-node "all-documents" "node:all" "person:all"))
    (quasar.workspace:apply-node-delete
     workspace
     (make-node "all-documents" "node:all"))
    (check (eq :null (graph-document-ids-for-test workspace "all-documents")))
    (check (null (graph-node (workspace-graph workspace "all-documents") "node:all")))))

(defun test-node-update-reconciles-membership ()
  (let ((workspace (make-workspace :id "node-update-membership")))
    (apply-document-create workspace (make-doc "person:old"))
    (apply-document-create workspace (make-doc "person:new"))
    (apply-node-create workspace (make-node "case" "node:person" "person:old"))
    (quasar.workspace:apply-node-update
     workspace
     (make-node "case" "node:person" "person:new"))
    (let ((ids (graph-document-ids-for-test workspace "case")))
      (check (member "person:new" ids :test #'string=))
      (check (null (member "person:old" ids :test #'string=))))))

(defun test-node-delete-retains-shared-membership ()
  (let ((workspace (make-workspace :id "shared-membership")))
    (apply-document-create workspace (make-doc "person:shared"))
    (apply-node-create workspace (make-node "case" "node:one" "person:shared"))
    (apply-node-create workspace (make-node "case" "node:two" "person:shared"))
    (quasar.workspace:apply-node-delete
     workspace
     (make-node "case" "node:one"))
    (check (member "person:shared"
                   (graph-document-ids-for-test workspace "case")
                   :test #'string=))))

(defun test-relation-retype-blocked-while-edge-references-document ()
  (let ((workspace (make-workspace :id "relation-retype")))
    (apply-document-create workspace (make-doc "relation:1" "relation"))
    (apply-node-create workspace (make-node "case" "node:a"))
    (apply-node-create workspace (make-node "case" "node:b"))
    (let ((edge (make-edge "case" "edge:relation" "node:a" "node:b")))
      (quasar.protocol:object-set edge "documentId" "relation:1")
      (apply-edge-create workspace edge))
    (handler-case
        (quasar.workspace:apply-document-update
         workspace
         (make-doc "relation:1" "person"))
      (quasar.protocol:quasar-error (condition)
        (check (string= "graph.invalid-reference"
                        (quasar.protocol:quasar-error-code condition))))
      (:no-error (&rest values)
        (declare (ignore values))
        (incf *failures*)
        (format *error-output* "~&FAIL: referenced relation retype did not signal~%")))
    (check (string= "relation"
                    (quasar.protocol:json-value
                     (gethash "relation:1" (workspace-documents workspace))
                     "dtype")))))

(defun index-test-operation (type payload)
  (quasar.protocol:json-object (cons "type" type) (cons "payload" payload)))

(defun check-index-error (code thunk)
  (handler-case (progn (funcall thunk) (check nil))
    (quasar.protocol:quasar-error (condition)
      (check (string= code (quasar.protocol:quasar-error-code condition))))))

(defun test-graph-index-linear-probes ()
  ;; Endpoints at the end of the node array defeat linear-find shortcuts.
  (dolist (size '(32 128 512))
    (let* ((workspace (make-workspace))
           (nodes (loop for i below size collect
                    (make-node "indexed" (format nil "n~D" i))))
           (edges (loop for i below size collect
                    (make-edge "indexed" (format nil "e~D" i)
                               (format nil "n~D" (1- size)) "n0")))
           (payload (quasar.protocol:json-object
                     (cons "id" "indexed") (cons "nodes" (cons :array nodes))
                     (cons "edges" (cons :array edges))))
           (quasar.workspace::*graph-index-probes* 0))
      (quasar.workspace:apply-graph-put workspace payload)
      (check (= (* 4 size) quasar.workspace::*graph-index-probes*))
      (format t "~&graph.put V=E=~D: ~D probes~%"
              size quasar.workspace::*graph-index-probes*)
      (let ((before (quasar.protocol:encode (workspace-graph workspace "indexed"))))
        (dolist (case '(:duplicate-node :duplicate-edge :dangling :wrong-graph :relation))
          (let* ((bad (quasar.protocol:clone-json payload))
                 (ns (rest (quasar.protocol:json-value bad "nodes")))
                 (es (rest (quasar.protocol:json-value bad "edges"))))
            (ecase case
              (:duplicate-node (quasar.protocol:object-set (second ns) "id" "n0"))
              (:duplicate-edge (quasar.protocol:object-set (second es) "id" "e0"))
              (:dangling (quasar.protocol:object-set (first es) "target" "missing"))
              (:wrong-graph (quasar.protocol:object-set (first ns) "graphId" "other"))
              (:relation (quasar.protocol:object-set (first es) "documentId" "missing")))
            (check-index-error
             (if (member case '(:duplicate-node :duplicate-edge))
                 "graph.duplicate-id" "graph.invalid-reference")
             (lambda () (quasar.workspace:apply-graph-put workspace bad)))
            (check (string= before (quasar.protocol:encode
                                   (workspace-graph workspace "indexed"))))))))))

(defun test-graph-index-bulk-and-mixed ()
  (dolist (size '(32 128 512))
    (let* ((workspace (make-workspace))
           (quasar.workspace::*graph-index-probes* 0)
           (quasar.workspace::*graph-index-build-visits* 0)
           (quasar.workspace::*graph-index-appends* 0))
      (quasar.workspace:commit-operations
       workspace
       (append
        (loop for i below size collect
          (index-test-operation "graph.node.create"
                                (make-node "indexed" (format nil "n~D" i))))
        (loop for i below size collect
          (index-test-operation "graph.edge.create"
                               (make-edge "indexed" (format nil "e~D" i)
                                          (format nil "n~D" (1- size)) "n0")))))
      (check (= (* 4 size) quasar.workspace::*graph-index-probes*))
      (check (zerop quasar.workspace::*graph-index-build-visits*))
      (check (= (* 2 size) quasar.workspace::*graph-index-appends*))
      (check (equal (loop for i below size collect (format nil "n~D" i))
                    (mapcar (lambda (node) (quasar.protocol:json-value node "id"))
                            (rest (quasar.protocol:json-value
                                   (workspace-graph workspace "indexed") "nodes")))))
      (format t "~&bulk V=E=~D: ~D probes~%" size quasar.workspace::*graph-index-probes*)
      ;; Replacement, removal, and recreation must not retain old endpoint entries.
      (quasar.workspace:commit-operations
       workspace
       (list (index-test-operation "graph.node.update" (make-node "indexed" "n0"))
             (index-test-operation "graph.node.delete" (make-node "indexed" "n0"))
             (index-test-operation "graph.node.create" (make-node "indexed" "n0"))
             (index-test-operation "graph.edge.create" (make-edge "indexed" "restored" "n0" "n1"))))
      (check (graph-node (workspace-graph workspace "indexed") "n0"))
      (let ((before (quasar.protocol:encode (workspace-graph workspace "indexed")))
            (candidate (quasar.workspace:copy-workspace workspace)))
        (check-index-error
         "graph.invalid-reference"
         (lambda ()
           (quasar.workspace:commit-operations
            candidate
            (list (index-test-operation "graph.node.create" (make-node "indexed" "new"))
                  (index-test-operation "graph.node.delete" (make-node "indexed" "n0"))
                  (index-test-operation "graph.edge.create" (make-edge "indexed" "bad" "new" "n0"))))))
        (check (string= before (quasar.protocol:encode (workspace-graph workspace "indexed"))))))))

(defun run-workspace-integrity-tests ()
  (test-graph-index-linear-probes)
  (test-graph-index-bulk-and-mixed)
  (test-all-documents-node-delete-preserves-null-membership)
  (test-node-update-reconciles-membership)
  (test-node-delete-retains-shared-membership)
  (test-relation-retype-blocked-while-edge-references-document)
  t)
