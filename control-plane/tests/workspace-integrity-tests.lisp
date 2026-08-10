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

(defun run-workspace-integrity-tests ()
  (test-all-documents-node-delete-preserves-null-membership)
  (test-node-update-reconciles-membership)
  (test-node-delete-retains-shared-membership)
  (test-relation-retype-blocked-while-edge-references-document)
  t)
