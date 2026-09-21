(in-package #:quasar.tests)

(defun prolog-test-array-elements (value)
  (if (and (consp value) (eq (car value) :array))
      (rest value)
      value))

(defun test-prolog-snapshot-is-deterministic-and-bounded ()
  (let ((workspace (make-workspace :id "prolog-io-snapshot")))
    (apply-document-create workspace (make-doc "person:z"))
    (apply-document-create workspace (make-doc "relation:a" "relation"))
    (apply-document-create workspace (make-doc "person:m"))
    (let* ((snapshot
             (quasar.control-plane::build-prolog-snapshot
              workspace
              (quasar.protocol:json-object (cons "limit" 2))))
           (documents
             (prolog-test-array-elements
              (quasar.protocol:json-value snapshot "documents"))))
      (check (string= "quasar.prolog.io.v1"
                      (quasar.protocol:json-value snapshot "schema")))
      (check (= 3 (quasar.protocol:json-value snapshot "total")))
      (check (= 2 (length documents)))
      (check (string= "person:m"
                      (quasar.protocol:json-value (first documents) "_id")))
      (check (string= "person:z"
                      (quasar.protocol:json-value (second documents) "_id")))
      (check (= 2 (quasar.protocol:json-value snapshot "nextOffset"))))))

(defun test-prolog-snapshot-filters-dtype ()
  (let ((workspace (make-workspace :id "prolog-io-filter")))
    (apply-document-create workspace (make-doc "person:1"))
    (apply-document-create workspace (make-doc "relation:1" "relation"))
    (let* ((snapshot
             (quasar.control-plane::build-prolog-snapshot
              workspace
              (quasar.protocol:json-object
               (cons "dtypes"
                     (quasar.protocol:json-array "relation")))))
           (documents
             (prolog-test-array-elements
              (quasar.protocol:json-value snapshot "documents"))))
      (check (= 1 (length documents)))
      (check (string= "relation:1"
                      (quasar.protocol:json-value (first documents) "_id"))))))

(defun test-prolog-proposal-validates-without-writing ()
  (let* ((workspace (make-workspace :id "prolog-io-proposal"))
         (operation
           (quasar.protocol:json-object
            (cons "type" "document.create")
            (cons "payload" (make-doc "person:pending"))))
         (result
           (quasar.control-plane::validate-prolog-proposal
            workspace
            (quasar.protocol:json-object
             (cons "expectedRevision" 0)
             (cons "operations"
                   (quasar.protocol:json-array operation))))))
    (check (eq t (quasar.protocol:json-value result "valid")))
    (check (= 1 (quasar.protocol:json-value result "operationCount")))
    (check (null (gethash "person:pending"
                          (workspace-documents workspace))))
    (check (= 0 (workspace-revision workspace)))))

(defun test-prolog-proposal-rejects-non-quasar-execution ()
  (let* ((workspace (make-workspace :id "prolog-io-reject"))
         (operation
           (quasar.protocol:json-object
            (cons "type" "starlang.load")
            (cons "payload" (quasar.protocol:empty-object)))))
    (handler-case
        (progn
          (quasar.control-plane::validate-prolog-proposal
           workspace
           (quasar.protocol:json-object
            (cons "operations"
                  (quasar.protocol:json-array operation))))
          (incf *failures*)
          (format *error-output*
                  "~&FAIL: unsafe Prolog proposal type was accepted~%"))
      (quasar.protocol:quasar-error (condition)
        (check
         (string=
          "prolog.proposal.invalid-operation"
          (quasar.protocol:quasar-error-code condition)))))))

(defun run-prolog-io-tests ()
  (test-prolog-snapshot-is-deterministic-and-bounded)
  (test-prolog-snapshot-filters-dtype)
  (test-prolog-proposal-validates-without-writing)
  (test-prolog-proposal-rejects-non-quasar-execution)
  t)
