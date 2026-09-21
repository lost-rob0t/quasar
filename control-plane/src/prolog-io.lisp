(in-package #:quasar.control-plane)

(defparameter +prolog-io-schema+ "quasar.prolog.io.v1")
(defparameter +prolog-io-default-limit+ 250)
(defparameter +prolog-io-max-limit+ 1000)

(defparameter +prolog-proposal-operation-types+
  '("document.create"
    "document.update"
    "document.delete"
    "graph.put"
    "graph.delete"
    "graph.activate"
    "graph.node.create"
    "graph.node.update"
    "graph.node.delete"
    "graph.edge.create"
    "graph.edge.update"
    "graph.edge.delete"))

(defparameter +prolog-projection-fields+
  '("_id"
    "dtype"
    "dataset"
    "schema_version"
    "version"
    "date_added"
    "date_updated"
    "title"
    "summary"
    "status"
    "language"
    "tags"
    "sources"
    "evidence"
    "assessment"
    "handling"
    "provenance"
    "lineage"
    "related_ids"
    "workflow"
    "data"))

(defun prolog-io-error (code message)
  (error 'quasar.protocol:quasar-error
         :code code
         :message message))

(defun prolog-array-elements (value)
  (cond
    ((null value) nil)
    ((and (consp value) (eq (car value) :array)) (rest value))
    ((listp value) value)
    (t (prolog-io-error "prolog.invalid-request"
                        "Expected a JSON array."))))

(defun prolog-string-list (payload key)
  (let ((raw (quasar.protocol:json-value payload key)))
    (when raw
      (let ((array (quasar.protocol:ensure-array
                    raw key "prolog.invalid-request")))
        (mapcar (lambda (value)
                  (quasar.protocol:ensure-string
                   value key "prolog.invalid-request"))
                (prolog-array-elements array))))))

(defun prolog-document-projection (document)
  (let ((result (quasar.protocol:empty-object)))
    (dolist (key +prolog-projection-fields+ result)
      (let* ((missing (gensym "MISSING"))
             (value (quasar.protocol:json-value document key missing)))
        (unless (eq value missing)
          (quasar.protocol:object-set
           result key (quasar.protocol:clone-json value)))))))

(defun prolog-document-selected-p (document ids dtypes)
  (let ((id (quasar.protocol:json-value document "_id"))
        (dtype (quasar.protocol:json-value document "dtype")))
    (and (or (null ids) (member id ids :test #'string=))
         (or (null dtypes) (member dtype dtypes :test #'string=)))))

(defun prolog-page-bounds (payload)
  (let ((offset (or (quasar.protocol:json-value payload "offset") 0))
        (limit (or (quasar.protocol:json-value payload "limit")
                   +prolog-io-default-limit+)))
    (unless (and (integerp offset) (not (minusp offset)))
      (prolog-io-error "prolog.invalid-request"
                       "offset must be a non-negative integer."))
    (unless (and (integerp limit) (plusp limit))
      (prolog-io-error "prolog.invalid-request"
                       "limit must be a positive integer."))
    (values offset (min limit +prolog-io-max-limit+))))

(defun build-prolog-snapshot (workspace payload)
  "Build a bounded deterministic Prolog projection without mutating WORKSPACE."
  (multiple-value-bind (offset limit)
      (prolog-page-bounds payload)
    (let* ((ids (prolog-string-list payload "documentIds"))
           (dtypes (prolog-string-list payload "dtypes"))
           (documents
             (sort
              (loop for document being the hash-values
                      of (quasar.workspace:workspace-documents workspace)
                    when (prolog-document-selected-p document ids dtypes)
                      collect document)
              #'string<
              :key (lambda (document)
                     (or (quasar.protocol:json-value document "_id") ""))))
           (total (length documents))
           (end (min total (+ offset limit)))
           (page (if (< offset total)
                     (subseq documents offset end)
                     nil))
           (next-offset (if (< end total) end :null)))
      (quasar.protocol:json-object
       (cons "schema" +prolog-io-schema+)
       (cons "workspaceId" (quasar.workspace:workspace-id workspace))
       (cons "revision" (quasar.workspace:workspace-revision workspace))
       (cons "offset" offset)
       (cons "limit" limit)
       (cons "total" total)
       (cons "nextOffset" next-offset)
       (cons "documents"
             (apply #'quasar.protocol:json-array
                    (mapcar #'prolog-document-projection page)))))))

(defun validate-prolog-operation-type (operation)
  (let ((type (quasar.protocol:ensure-string
               (quasar.protocol:json-value operation "type")
               "type"
               "prolog.proposal.invalid-operation")))
    (unless (member type +prolog-proposal-operation-types+ :test #'string=)
      (prolog-io-error
       "prolog.proposal.invalid-operation"
       (format nil "Operation ~A is not available through the Prolog proposal boundary."
               type)))
    type))

(defun validate-prolog-proposal (workspace payload)
  "Validate proposed Quasar operations against a copy of WORKSPACE.

This is intentionally read-only.  The caller must submit accepted operations
through the ordinary Quasar command/transaction authority to persist them."
  (let* ((expected-revision
           (quasar.protocol:json-value payload "expectedRevision"))
         (operations
           (quasar.protocol:ensure-array
            (quasar.protocol:json-value payload "operations")
            "operations"
            "prolog.proposal.invalid"))
         (items (prolog-array-elements operations)))
    (unless items
      (prolog-io-error "prolog.proposal.invalid"
                       "A Prolog proposal must contain at least one operation."))
    (when expected-revision
      (unless (integerp expected-revision)
        (prolog-io-error "prolog.proposal.invalid"
                         "expectedRevision must be an integer."))
      (unless (= expected-revision
                 (quasar.workspace:workspace-revision workspace))
        (prolog-io-error "workspace.revision-conflict"
                         "The Prolog proposal was produced from a stale workspace revision.")))
    (dolist (operation items)
      (quasar.protocol:ensure-object
       operation "operation" "prolog.proposal.invalid-operation")
      (validate-prolog-operation-type operation))
    (let ((candidate (quasar.workspace:copy-workspace workspace)))
      (multiple-value-bind (applied inverses)
          (quasar.workspace:commit-operations candidate items)
        (declare (ignore inverses))
        (quasar.protocol:json-object
         (cons "schema" +prolog-io-schema+)
         (cons "valid" t)
         (cons "workspaceId" (quasar.workspace:workspace-id workspace))
         (cons "baseRevision" (quasar.workspace:workspace-revision workspace))
         (cons "operationCount" (length applied))
         (cons "results"
               (apply #'quasar.protocol:json-array
                      (mapcar
                       (lambda (item)
                         (quasar.protocol:json-object
                          (cons "event"
                                (quasar.workspace:applied-op-event item))
                          (cons "result"
                                (quasar.protocol:clone-json
                                 (quasar.workspace:applied-op-result item)))))
                       applied))))))))

(defun install-prolog-io-commands (plane)
  (register-command
   plane
   "prolog.snapshot"
   (lambda (payload envelope)
     (build-prolog-snapshot (workspace-for plane envelope) payload)))
  (register-command
   plane
   "prolog.proposal.validate"
   (lambda (payload envelope)
     (validate-prolog-proposal (workspace-for plane envelope) payload)))
  plane)
