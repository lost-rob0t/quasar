(in-package #:quasar.store)

(defun %valid-import-document (document)
  (quasar.protocol:ensure-object document "document" "document.invalid")
  (let ((id (quasar.protocol:json-value document "_id"))
        (dtype (quasar.protocol:json-value document "dtype")))
    (quasar.protocol:ensure-string id "_id" "document.invalid")
    (unless (and (stringp dtype) (plusp (length dtype)))
      (%stage-error
       "document.invalid"
       "Document dtype must be a non-empty string.")))
  document)

(defun %generated-import-id (document)
  (format nil
          "~A:~36R:~36R"
          (or (quasar.protocol:json-value document "dtype") "document")
          (get-universal-time)
          (random most-positive-fixnum)))

(defun %canonical-or-staged-document
    (database workspace-id stage-id document-id)
  (or
   (tek9:fetch*
    database
    (%stage-document-key workspace-id stage-id document-id))
   (tek9:fetch* database (%document-key workspace-id document-id))))

(defun %relation-edge-reference-p (database workspace-id document-id)
  (let ((prefix
          (concatenate
           'string
           (%workspace-prefix workspace-id)
           "edge/"))
        (start nil))
    (loop
      for rows = (%bounded-range database prefix :start start)
      while rows
      do
        (dolist (row rows)
          (when
              (string=
               document-id
               (or
                (quasar.protocol:json-value
                 (cdr row) "documentId")
                ""))
            (return-from %relation-edge-reference-p t)))
        (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+))
    nil))

(defun %stage-document-create (database workspace-id stage-id payload)
  (let ((canonical (quasar.protocol:clone-json payload)))
    (unless (quasar.protocol:json-value canonical "_id")
      (quasar.protocol:object-set
       canonical "_id" (%generated-import-id canonical)))
    (%valid-import-document canonical)
    (let ((id (quasar.protocol:json-value canonical "_id")))
      (when
          (%canonical-or-staged-document
           database workspace-id stage-id id)
        (%stage-error
         "document.duplicate-id"
         (format nil "Document ~A already exists." id)))
      (%put-record
       database
       (%stage-document-key workspace-id stage-id id)
       canonical)
      canonical)))

(defun %stage-document-update (database workspace-id stage-id payload)
  (let ((canonical (quasar.protocol:clone-json payload)))
    (%valid-import-document canonical)
    (let* ((id (quasar.protocol:json-value canonical "_id"))
           (previous
             (%canonical-or-staged-document
              database workspace-id stage-id id)))
      (unless previous
        (%stage-error
         "document.not-found"
         (format nil "Document ~A does not exist." id)))
      (when
          (and
           (string=
            (or (quasar.protocol:json-value previous "dtype") "")
            "relation")
           (not
            (string=
             (or (quasar.protocol:json-value canonical "dtype") "")
             "relation"))
           (%relation-edge-reference-p database workspace-id id))
        (%stage-error
         "graph.invalid-reference"
         (format nil
                 "Document ~A is referenced by relation edges."
                 id)))
      (%put-record
       database
       (%stage-document-key workspace-id stage-id id)
       canonical)
      canonical)))

(defun %apply-stage-operation (database workspace-id stage-id operation)
  (quasar.protocol:ensure-object
   operation "operation" "import.invalid-operation")
  (let ((type (quasar.protocol:json-value operation "type"))
        (payload (quasar.protocol:json-value operation "payload")))
    (cond
      ((string= (or type "") "document.create")
       (%stage-document-create database workspace-id stage-id payload))
      ((string= (or type "") "document.update")
       (%stage-document-update database workspace-id stage-id payload))
      (t
       (%stage-error
        "import.invalid-operation"
        "Import chunks may only create or update documents.")))))

(defun %operations-list (operations)
  (quasar.workspace:array-elements
   (quasar.protocol:ensure-array
    operations "operations" "protocol.invalid-envelope")))

(defmethod begin-import-stage
    ((store tek9-store) workspace-id stage-id base-revision now)
  (let ((database (tek9-store-database store)))
    (tek9:with-write-transaction (database)
      (let* ((current (or (%stored-revision database workspace-id) 0))
             (active (%active-stage-id database workspace-id)))
        (unless (= current base-revision)
          (%stage-error
           "workspace.revision-conflict"
           (format nil
                   "Workspace ~A is at revision ~D, expected ~D."
                   workspace-id current base-revision)))
        (when active
          (let ((active-meta
                  (tek9:fetch*
                   database
                   (%stage-meta-key workspace-id active))))
            (when
                (and
                 active-meta
                 (member
                  (quasar.protocol:json-value active-meta "state")
                  '("OPEN" "COMMITTING")
                  :test #'string=))
              (%stage-error
               "import.busy"
               "This workspace already has an active document import.")))
          (tek9:delete-document
           database (%active-stage-key workspace-id)))
        (%put-record
         database
         (%stage-meta-key workspace-id stage-id)
         (%stage-meta workspace-id stage-id base-revision now))
        (%put-active-stage database workspace-id stage-id)))
    (quasar.protocol:json-object
     (cons "sessionId" stage-id)
     (cons "baseRevision" base-revision)
     (cons "state" "OPEN"))))

(defmethod accept-import-chunk
    ((store tek9-store) workspace-id stage-id sequence operations now)
  (unless (and (integerp sequence) (not (minusp sequence)))
    (%stage-error
     "import.invalid-sequence"
     "Import chunk sequence must be a non-negative integer."))
  (let* ((items (%operations-list operations))
         (encoded (quasar.protocol:encode operations))
         (byte-count (%utf8-length encoded)))
    (when (> (length items) +import-max-operations-per-chunk+)
      (%stage-error
       "import.chunk-too-many-operations"
       "The import chunk exceeds the operation budget."))
    (when (> byte-count +import-max-chunk-bytes+)
      (%stage-error
       "import.chunk-too-large"
       "The import chunk exceeds the byte budget."))
    (let ((database (tek9-store-database store))
          (digest (%fnv1a-64 encoded))
          (result nil))
      (tek9:with-write-transaction (database)
        (let* ((meta
                 (%stage-open-required
                  database workspace-id stage-id))
               (accepted
                 (or
                  (quasar.protocol:json-value
                   meta "acceptedThrough")
                  -1)))
          (cond
            ((<= sequence accepted)
             (let ((record
                     (tek9:fetch*
                      database
                      (%stage-chunk-key
                       workspace-id stage-id sequence))))
               (unless
                   (and
                    record
                    (string=
                     digest
                     (or
                      (quasar.protocol:json-value record "digest")
                      "")))
                 (%stage-error
                  "import.chunk-conflict"
                  "The chunk sequence was already accepted with different content."))
               (setf result
                     (quasar.protocol:json-object
                      (cons "sessionId" stage-id)
                      (cons
                       "documentCount"
                       (quasar.protocol:json-value
                        meta "documentCount" 0))
                      (cons "acceptedThrough" accepted)
                      (cons "replayed" t)))))
            ((/= sequence (1+ accepted))
             (%stage-error
              "import.sequence-gap"
              (format nil
                      "Expected import chunk sequence ~D, received ~D."
                      (1+ accepted)
                      sequence)))
            (t
             (let ((hook (tek9-store-failure-hook store)))
               (when hook
                 (funcall hook :before-import-chunk)))
             (dolist (operation items)
               (%apply-stage-operation
                database workspace-id stage-id operation))
             (let ((hook (tek9-store-failure-hook store)))
               (when hook
                 (funcall hook :after-import-documents)))
             (%put-record
              database
              (%stage-chunk-key workspace-id stage-id sequence)
              (quasar.protocol:json-object
               (cons "sequence" sequence)
               (cons "digest" digest)
               (cons "byteCount" byte-count)
               (cons "operationCount" (length items))))
             (quasar.protocol:object-set
              meta "acceptedThrough" sequence)
             (quasar.protocol:object-set
              meta
              "documentCount"
              (+
               (quasar.protocol:json-value
                meta "documentCount" 0)
               (length items)))
             (quasar.protocol:object-set
              meta
              "byteCount"
              (+
               (quasar.protocol:json-value meta "byteCount" 0)
               byte-count))
             (quasar.protocol:object-set
              meta "lastActivityAt" now)
             (let ((hook (tek9-store-failure-hook store)))
               (when hook
                 (funcall hook :before-import-metadata)))
             (%put-record
              database
              (%stage-meta-key workspace-id stage-id)
              meta)
             (setf result
                   (quasar.protocol:json-object
                    (cons "sessionId" stage-id)
                    (cons
                     "documentCount"
                     (quasar.protocol:json-value
                      meta "documentCount" 0))
                    (cons "acceptedThrough" sequence)
                    (cons "replayed" :false)))))))
      result)))

(defun %canonical-document-count (database workspace-id meta)
  (let ((stored
          (and
           meta
           (quasar.protocol:json-value
            meta "documentCount" nil))))
    (if (and (integerp stored) (not (minusp stored)))
        stored
        (%count-prefix-bounded
         database (%document-prefix workspace-id)))))

(defun %promote-stage-documents (database workspace-id stage-id)
  (let ((prefix (%stage-document-prefix workspace-id stage-id))
        (start nil)
        (created 0))
    (loop
      for rows = (%bounded-range database prefix :start start)
      while rows
      do
        (dolist (row rows)
          (let* ((document (cdr row))
                 (id (quasar.protocol:json-value document "_id"))
                 (canonical-key
                   (%document-key workspace-id id)))
            (unless (tek9:fetch* database canonical-key)
              (incf created))
            (%put-record database canonical-key document)))
        (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+))
    created))

(defun %ensure-default-graph-metadata (database workspace-id)
  (unless
      (%bounded-range
       database (%graph-meta-prefix workspace-id) :limit 1)
    (%put-record
     database
     (%graph-meta-key workspace-id "all-documents")
     (quasar.protocol:json-object
      (cons "id" "all-documents")
      (cons "name" "all-documents")
      (cons "documentIds" :null)
      (cons "positions" (quasar.protocol:empty-object))
      (cons "viewport" :null)
      (cons "layout" "cose")
      (cons "selectedIds" (quasar.protocol:json-array))
      (cons "groups" (quasar.protocol:empty-object))))))

(defun %compact-import-journal
    (workspace-id stage-id operation-id client
     base-revision committed-revision document-count byte-count now)
  (quasar.protocol:json-object
   (cons "operationId" operation-id)
   (cons "workspaceId" workspace-id)
   (cons "sessionId" stage-id)
   (cons "baseRevision" base-revision)
   (cons "committedRevision" committed-revision)
   (cons "command" "document.import")
   (cons "documentCount" document-count)
   (cons "byteCount" byte-count)
   (cons "timestamp" now)
   (cons "client" client)))