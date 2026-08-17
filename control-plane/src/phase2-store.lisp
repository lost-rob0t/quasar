(in-package #:quasar.store)

(defparameter +phase2-range-batch-size+ 128)
(defparameter +import-max-chunk-bytes+ (* 1024 1024))
(defparameter +import-max-operations-per-chunk+ 1000)
(defparameter +import-stage-ttl-seconds+ (* 24 60 60))

(defgeneric direct-document (store workspace-id document-id)
  (:documentation "Fetch one canonical document without materializing its workspace."))

(defgeneric direct-document-list (store workspace-id)
  (:documentation "Fetch canonical documents directly from the store in stable key order."))

(defgeneric direct-workspace-snapshot-page (store workspace-id offset byte-limit)
  (:documentation "Return one bounded document page plus durable workspace/graph metadata."))

(defgeneric begin-import-stage (store workspace-id stage-id base-revision now)
  (:documentation "Create one durable OPEN import stage."))

(defgeneric accept-import-chunk (store workspace-id stage-id sequence operations now)
  (:documentation "Atomically validate and durably accept one sequenced import chunk."))

(defgeneric promote-import-stage (store workspace-id stage-id operation-id client now)
  (:documentation "Atomically promote one durable stage into canonical workspace state."))

(defgeneric abort-import-stage (store workspace-id stage-id now)
  (:documentation "Idempotently abort and remove one durable import stage."))

(defgeneric cleanup-expired-import-stages (store now &key ttl-seconds)
  (:documentation "Remove expired OPEN stages without scanning unrelated canonical records."))

(defmethod direct-document ((store memory-store) workspace-id document-id)
  (let ((workspace (load-workspace store workspace-id)))
    (and workspace
         (let ((document (gethash document-id
                                  (quasar.workspace:workspace-documents workspace))))
           (and document (quasar.protocol:clone-json document))))))

(defmethod direct-document-list ((store memory-store) workspace-id)
  (let ((workspace (load-workspace store workspace-id)))
    (when workspace
      (sort
       (loop for document being the hash-values
               of (quasar.workspace:workspace-documents workspace)
             collect (quasar.protocol:clone-json document))
       #'string<
       :key (lambda (document)
              (quasar.protocol:json-value document "_id"))))))

(defmethod direct-workspace-snapshot-page ((store memory-store) workspace-id offset byte-limit)
  (let ((workspace (or (load-workspace store workspace-id)
                       (quasar.workspace:make-workspace :id workspace-id))))
    (quasar.workspace:workspace-snapshot-page workspace offset byte-limit)))

(defun streaming-store-p (store)
  (typep store 'tek9-store))

(defun %stage-root-prefix ()
  "quasar/v1/stage/")

(defun %stage-workspace-prefix (workspace-id)
  (format nil "~A~A/" (%stage-root-prefix) (%key-part workspace-id)))

(defun %stage-prefix (workspace-id stage-id)
  (format nil "~A~A/" (%stage-workspace-prefix workspace-id) (%key-part stage-id)))

(defun %stage-meta-key (workspace-id stage-id)
  (concatenate 'string (%stage-prefix workspace-id stage-id) "meta"))

(defun %stage-document-prefix (workspace-id stage-id)
  (concatenate 'string (%stage-prefix workspace-id stage-id) "doc/"))

(defun %stage-document-key (workspace-id stage-id document-id)
  (concatenate 'string (%stage-document-prefix workspace-id stage-id)
               (%key-part document-id)))

(defun %stage-chunk-prefix (workspace-id stage-id)
  (concatenate 'string (%stage-prefix workspace-id stage-id) "chunk/"))

(defun %stage-chunk-key (workspace-id stage-id sequence)
  (format nil "~A~20,'0D" (%stage-chunk-prefix workspace-id stage-id) sequence))

(defun %active-stage-prefix ()
  "quasar/v1/stage-active/")

(defun %active-stage-key (workspace-id)
  (concatenate 'string (%active-stage-prefix) (%key-part workspace-id)))

(defun %prefix-p (prefix key)
  (and (<= (length prefix) (length key))
       (string= prefix key :end2 (length prefix))))

(defun %bounded-range (database prefix &key start (limit +phase2-range-batch-size+))
  "Return at most LIMIT rows in PREFIX after START, using Tek9's ordered seek.
START is an already-consumed key and is therefore excluded when still present."
  (let* ((seek (or start prefix))
         (raw (tek9:select-primary-range
               database seek :end (%prefix-end prefix)
               :limit (if start (1+ limit) limit)))
         (rows (loop for row in raw
                     while (%prefix-p prefix (car row))
                     unless (and start (string= (car row) start))
                       collect row)))
    (if (> (length rows) limit)
        (subseq rows 0 limit)
        rows)))

(defun %delete-prefix-bounded (database prefix)
  "Delete PREFIX in bounded batches. The next seek restarts at PREFIX because
prior keys are gone, so no corpus-sized key list is retained."
  (loop
    for rows = (%bounded-range database prefix)
    while rows
    do (dolist (row rows)
         (tek9:delete-document database (car row)))
    finally (return t)))

(defun %count-prefix-bounded (database prefix)
  (let ((count 0)
        (start nil))
    (loop
      for rows = (%bounded-range database prefix :start start)
      while rows
      do (incf count (length rows))
         (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+))
    count))

(defun %utf8-length (string)
  (length (babel:string-to-octets string :encoding :utf-8)))

(defun %fnv1a-64 (string)
  "Stable non-cryptographic content digest used only for replay identity."
  (let ((hash #xcbf29ce484222325))
    (loop for octet across (babel:string-to-octets string :encoding :utf-8)
          do (setf hash (logand #xffffffffffffffff
                                (* (logxor hash octet) #x100000001b3))))
    (format nil "~16,'0X" hash)))

(defun %stage-error (code message &optional (details (quasar.protocol:empty-object)))
  (error 'quasar.protocol:quasar-error
         :code code :message message :details details))

(defun %stage-meta (workspace-id stage-id base-revision now)
  (quasar.protocol:json-object
   (cons "storageSchemaVersion" +tek9-schema-version+)
   (cons "sessionId" stage-id)
   (cons "workspaceId" workspace-id)
   (cons "baseRevision" base-revision)
   (cons "createdAt" now)
   (cons "lastActivityAt" now)
   (cons "state" "OPEN")
   (cons "acceptedThrough" -1)
   (cons "documentCount" 0)
   (cons "byteCount" 0)
   (cons "validationState" "VALID")))

(defun %stage-meta-required (database workspace-id stage-id)
  (or (tek9:fetch* database (%stage-meta-key workspace-id stage-id))
      (%stage-error "import.invalid-session"
                    "The document import session does not exist.")))

(defun %stage-open-required (database workspace-id stage-id)
  (let ((meta (%stage-meta-required database workspace-id stage-id)))
    (unless (string= "OPEN" (or (quasar.protocol:json-value meta "state") ""))
      (%stage-error "import.invalid-session"
                    "The document import session is not open."))
    meta))

(defun %active-stage-id (database workspace-id)
  (let ((record (tek9:fetch* database (%active-stage-key workspace-id))))
    (and record (quasar.protocol:json-value record "sessionId"))))

(defun %put-active-stage (database workspace-id stage-id)
  (%put-record
   database (%active-stage-key workspace-id)
   (quasar.protocol:json-object
    (cons "workspaceId" workspace-id)
    (cons "sessionId" stage-id))))

(defun %clear-active-stage-if (database workspace-id stage-id)
  (let ((active (%active-stage-id database workspace-id)))
    (when (and active (string= active stage-id))
      (tek9:delete-document database (%active-stage-key workspace-id)))))

(defun %default-workspace-meta (workspace-id revision document-count)
  (quasar.protocol:json-object
   (cons "storageSchemaVersion" +tek9-schema-version+)
   (cons "workspaceId" workspace-id)
   (cons "revision" revision)
   (cons "documentCount" document-count)
   (cons "activeGraphId" "all-documents")
   (cons "settings"
         (quasar.protocol:json-object
          (cons "activeGraphId" "all-documents")))))

(defun %workspace-meta-with-document-count (workspace)
  (let ((meta
          (quasar.protocol:json-object
           (cons "storageSchemaVersion" +tek9-schema-version+)
           (cons "workspaceId" (quasar.workspace:workspace-id workspace))
           (cons "revision" (quasar.workspace:workspace-revision workspace))
           (cons "documentCount"
                 (hash-table-count (quasar.workspace:workspace-documents workspace)))
           (cons "activeGraphId"
                 (or (gethash "activeGraphId"
                              (quasar.workspace:workspace-settings workspace))
                     "all-documents"))
           (cons "settings" (%workspace-settings-object workspace)))))
    meta))

;; Phase 2 extends schema-v1 metadata without changing any canonical key. The
;; original COMMIT-WORKSPACE calls this package-local function dynamically.
(defun %workspace-meta (workspace)
  (%workspace-meta-with-document-count workspace))

(defmethod direct-document ((store tek9-store) workspace-id document-id)
  (let ((document
          (tek9:fetch* (tek9-store-database store)
                       (%document-key workspace-id document-id))))
    (and document (quasar.protocol:clone-json document))))

(defmethod direct-document-list ((store tek9-store) workspace-id)
  (mapcar #'quasar.protocol:clone-json
          (%range-values (tek9-store-database store)
                         (%document-prefix workspace-id))))

(defun %restore-metadata-workspace (store workspace-id meta)
  (let ((workspace (quasar.workspace:make-workspace :id workspace-id)))
    (clrhash (quasar.workspace:workspace-graphs workspace))
    (setf (quasar.workspace:workspace-revision workspace)
          (or (quasar.protocol:json-value meta "revision") 0))
    (%restore-settings workspace
                       (or (quasar.protocol:json-value meta "settings")
                           (quasar.protocol:empty-object)))
    (unless (gethash "activeGraphId" (quasar.workspace:workspace-settings workspace))
      (setf (gethash "activeGraphId" (quasar.workspace:workspace-settings workspace))
            (or (quasar.protocol:json-value meta "activeGraphId")
                "all-documents")))
    (dolist (graph-meta (%range-values (tek9-store-database store)
                                      (%graph-meta-prefix workspace-id)))
      (%restore-graph store workspace graph-meta))
    (when (zerop (hash-table-count (quasar.workspace:workspace-graphs workspace)))
      (let ((graph (quasar.protocol:json-object
                    (cons "id" "all-documents")
                    (cons "name" "all-documents")
                    (cons "nodes" (quasar.protocol:json-array))
                    (cons "edges" (quasar.protocol:json-array))
                    (cons "documentIds" :null)
                    (cons "positions" (quasar.protocol:empty-object))
                    (cons "viewport" :null)
                    (cons "layout" "cose")
                    (cons "selectedIds" (quasar.protocol:json-array))
                    (cons "groups" (quasar.protocol:empty-object)))))
        (setf (quasar.workspace:workspace-graph workspace "all-documents") graph)))
    workspace))

(defun %settings-json (workspace)
  (apply #'quasar.protocol:json-object
         (loop for key being the hash-keys of (quasar.workspace:workspace-settings workspace)
               using (hash-value value)
               collect (cons key (quasar.protocol:clone-json value)))))

(defun %graphs-json (workspace)
  (apply #'quasar.protocol:json-array
         (sort
          (loop for graph being the hash-values
                  of (quasar.workspace:workspace-graphs workspace)
                collect (quasar.protocol:clone-json graph))
          #'string<
          :key (lambda (graph) (quasar.protocol:json-value graph "id")))))

(defun %document-page-at-offset (database workspace-id offset byte-limit)
  (let ((prefix (%document-prefix workspace-id))
        (remaining offset)
        (next-offset offset)
        (page nil)
        (page-bytes 0)
        (start nil)
        (done nil)
        (more nil))
    (loop until done
          for rows = (%bounded-range database prefix :start start)
          do (when (null rows)
               (setf done t)
               (return))
             (dolist (row rows)
               (if (plusp remaining)
                   (decf remaining)
                   (let* ((document (cdr row))
                          (document-bytes
                            (%utf8-length (quasar.protocol:encode document))))
                     (if (and page (> (+ page-bytes document-bytes) byte-limit))
                         (progn
                           (setf more t done t)
                           (return))
                         (progn
                           (push (quasar.protocol:clone-json document) page)
                           (incf page-bytes document-bytes)
                           (incf next-offset)))))
             (unless done
               (setf start (caar (last rows)))
               (when (< (length rows) +phase2-range-batch-size+)
                 (setf done t))))
    (values (nreverse page) next-offset more page-bytes)))

(defmethod direct-workspace-snapshot-page ((store tek9-store) workspace-id offset byte-limit)
  (let ((database (tek9-store-database store)))
    (tek9:with-read-transaction (database)
      (let* ((meta (or (tek9:fetch* database (%workspace-meta-key workspace-id))
                       (%default-workspace-meta workspace-id 0 0)))
             (workspace (%restore-metadata-workspace store workspace-id meta))
             (total (quasar.protocol:json-value meta "documentCount" :null)))
        (multiple-value-bind (documents next-offset more page-bytes)
            (%document-page-at-offset database workspace-id offset byte-limit)
          (declare (ignore page-bytes))
          (let ((snapshot
                  (quasar.protocol:json-object
                   (cons "id" workspace-id)
                   (cons "revision" (quasar.workspace:workspace-revision workspace))
                   (cons "documents" (cons :array documents))
                   (cons "graphs" (%graphs-json workspace))
                   (cons "activeGraphId"
                         (or (gethash "activeGraphId"
                                      (quasar.workspace:workspace-settings workspace))
                             "all-documents"))
                   (cons "settings" (%settings-json workspace)))))
            (quasar.protocol:object-set
             snapshot "documentPage"
             (quasar.protocol:json-object
              (cons "offset" offset)
              (cons "nextOffset" next-offset)
              (cons "total" total)
              (cons "complete"
                    (if (integerp total)
                        (>= next-offset total)
                        (not more)))))
            snapshot))))))

(defun %valid-import-document (document)
  (quasar.protocol:ensure-object document "document" "document.invalid")
  (let ((id (quasar.protocol:json-value document "_id"))
        (dtype (quasar.protocol:json-value document "dtype")))
    (quasar.protocol:ensure-string id "_id" "document.invalid")
    (unless (and (stringp dtype) (plusp (length dtype)))
      (%stage-error "document.invalid" "Document dtype must be a non-empty string.")))
  document)

(defun %generated-import-id (document)
  (format nil "~A:~36R:~36R"
          (or (quasar.protocol:json-value document "dtype") "document")
          (get-universal-time)
          (random most-positive-fixnum)))

(defun %canonical-or-staged-document (database workspace-id stage-id document-id)
  (or (tek9:fetch* database (%stage-document-key workspace-id stage-id document-id))
      (tek9:fetch* database (%document-key workspace-id document-id))))

(defun %relation-edge-reference-p (database workspace-id document-id)
  (let ((prefix (concatenate 'string (%workspace-prefix workspace-id) "edge/"))
        (start nil)
        (found nil))
    (loop until found
          for rows = (%bounded-range database prefix :start start)
          while rows
          do (dolist (row rows)
               (when (string= document-id
                              (or (quasar.protocol:json-value (cdr row) "documentId") ""))
                 (setf found t)
                 (return)))
             (unless found
               (setf start (caar (last rows)))
               (when (< (length rows) +phase2-range-batch-size+)
                 (return))))
    found))

(defun %stage-document-create (database workspace-id stage-id payload)
  (let ((canonical (quasar.protocol:clone-json payload)))
    (unless (quasar.protocol:json-value canonical "_id")
      (quasar.protocol:object-set canonical "_id" (%generated-import-id canonical)))
    (%valid-import-document canonical)
    (let ((id (quasar.protocol:json-value canonical "_id")))
      (when (%canonical-or-staged-document database workspace-id stage-id id)
        (%stage-error "document.duplicate-id"
                      (format nil "Document ~A already exists." id)))
      (%put-record database (%stage-document-key workspace-id stage-id id) canonical)
      canonical)))

(defun %stage-document-update (database workspace-id stage-id payload)
  (let ((canonical (quasar.protocol:clone-json payload)))
    (%valid-import-document canonical)
    (let* ((id (quasar.protocol:json-value canonical "_id"))
           (previous (%canonical-or-staged-document database workspace-id stage-id id)))
      (unless previous
        (%stage-error "document.not-found"
                      (format nil "Document ~A does not exist." id)))
      (when (and (string= (or (quasar.protocol:json-value previous "dtype") "")
                          "relation")
                 (not (string= (or (quasar.protocol:json-value canonical "dtype") "")
                               "relation"))
                 (%relation-edge-reference-p database workspace-id id))
        (%stage-error "graph.invalid-reference"
                      (format nil "Document ~A is referenced by relation edges." id)))
      (%put-record database (%stage-document-key workspace-id stage-id id) canonical)
      canonical)))

(defun %apply-stage-operation (database workspace-id stage-id operation)
  (quasar.protocol:ensure-object operation "operation" "import.invalid-operation")
  (let ((type (quasar.protocol:json-value operation "type"))
        (payload (quasar.protocol:json-value operation "payload")))
    (cond
      ((string= (or type "") "document.create")
       (%stage-document-create database workspace-id stage-id payload))
      ((string= (or type "") "document.update")
       (%stage-document-update database workspace-id stage-id payload))
      (t
       (%stage-error "import.invalid-operation"
                     "Import chunks may only create or update documents.")))))

(defun %operations-list (operations)
  (quasar.workspace:array-elements
   (quasar.protocol:ensure-array operations "operations" "protocol.invalid-envelope")))

(defmethod begin-import-stage ((store tek9-store) workspace-id stage-id base-revision now)
  (let ((database (tek9-store-database store)))
    (tek9:with-write-transaction (database)
      (let* ((current (or (%stored-revision database workspace-id) 0))
             (active (%active-stage-id database workspace-id)))
        (unless (= current base-revision)
          (%stage-error "workspace.revision-conflict"
                        (format nil "Workspace ~A is at revision ~D, expected ~D."
                                workspace-id current base-revision)))
        (when active
          (let ((active-meta (tek9:fetch* database (%stage-meta-key workspace-id active))))
            (when (and active-meta
                       (member (quasar.protocol:json-value active-meta "state")
                               '("OPEN" "COMMITTING") :test #'string=))
              (%stage-error "import.busy"
                            "This workspace already has an active document import."))
            (tek9:delete-document database (%active-stage-key workspace-id))))
        (%put-record database (%stage-meta-key workspace-id stage-id)
                     (%stage-meta workspace-id stage-id base-revision now))
        (%put-active-stage database workspace-id stage-id)))
    (quasar.protocol:json-object
     (cons "sessionId" stage-id)
     (cons "baseRevision" base-revision)
     (cons "state" "OPEN"))))

(defmethod accept-import-chunk ((store tek9-store) workspace-id stage-id sequence operations now)
  (unless (and (integerp sequence) (not (minusp sequence)))
    (%stage-error "import.invalid-sequence"
                  "Import chunk sequence must be a non-negative integer."))
  (let* ((items (%operations-list operations))
         (encoded (quasar.protocol:encode operations))
         (byte-count (%utf8-length encoded)))
    (when (> (length items) +import-max-operations-per-chunk+)
      (%stage-error "import.chunk-too-many-operations"
                    "The import chunk exceeds the operation budget."))
    (when (> byte-count +import-max-chunk-bytes+)
      (%stage-error "import.chunk-too-large"
                    "The import chunk exceeds the byte budget."))
    (let ((database (tek9-store-database store))
          (digest (%fnv1a-64 encoded))
          (result nil))
      (tek9:with-write-transaction (database)
        (let* ((meta (%stage-open-required database workspace-id stage-id))
               (accepted (or (quasar.protocol:json-value meta "acceptedThrough") -1)))
          (cond
            ((<= sequence accepted)
             (let ((record (tek9:fetch* database
                                        (%stage-chunk-key workspace-id stage-id sequence))))
               (unless (and record
                            (string= digest
                                     (or (quasar.protocol:json-value record "digest") "")))
                 (%stage-error "import.chunk-conflict"
                               "The chunk sequence was already accepted with different content."))
               (setf result
                     (quasar.protocol:json-object
                      (cons "sessionId" stage-id)
                      (cons "documentCount"
                            (quasar.protocol:json-value meta "documentCount" 0))
                      (cons "acceptedThrough" accepted)
                      (cons "replayed" t)))))
            ((/= sequence (1+ accepted))
             (%stage-error "import.sequence-gap"
                           (format nil "Expected import chunk sequence ~D, received ~D."
                                   (1+ accepted) sequence)))
            (t
             (let ((hook (tek9-store-failure-hook store)))
               (when hook (funcall hook :before-import-chunk)))
             (dolist (operation items)
               (%apply-stage-operation database workspace-id stage-id operation))
             (let ((hook (tek9-store-failure-hook store)))
               (when hook (funcall hook :after-import-documents)))
             (%put-record
              database (%stage-chunk-key workspace-id stage-id sequence)
              (quasar.protocol:json-object
               (cons "sequence" sequence)
               (cons "digest" digest)
               (cons "byteCount" byte-count)
               (cons "operationCount" (length items))))
             (quasar.protocol:object-set meta "acceptedThrough" sequence)
             (quasar.protocol:object-set
              meta "documentCount"
              (+ (quasar.protocol:json-value meta "documentCount" 0)
                 (length items)))
             (quasar.protocol:object-set
              meta "byteCount"
              (+ (quasar.protocol:json-value meta "byteCount" 0) byte-count))
             (quasar.protocol:object-set meta "lastActivityAt" now)
             (let ((hook (tek9-store-failure-hook store)))
               (when hook (funcall hook :before-import-metadata)))
             (%put-record database (%stage-meta-key workspace-id stage-id) meta)
             (setf result
                   (quasar.protocol:json-object
                    (cons "sessionId" stage-id)
                    (cons "documentCount"
                          (quasar.protocol:json-value meta "documentCount" 0))
                    (cons "acceptedThrough" sequence)
                    (cons "replayed" :false)))))))
      result)))

(defun %canonical-document-count (database workspace-id meta)
  (let ((stored (and meta (quasar.protocol:json-value meta "documentCount"))))
    (if (and (integerp stored) (not (minusp stored)))
        stored
        (%count-prefix-bounded database (%document-prefix workspace-id)))))

(defun %promote-stage-documents (database workspace-id stage-id)
  (let ((prefix (%stage-document-prefix workspace-id stage-id))
        (start nil)
        (created 0))
    (loop
      for rows = (%bounded-range database prefix :start start)
      while rows
      do (dolist (row rows)
           (let* ((document (cdr row))
                  (id (quasar.protocol:json-value document "_id"))
                  (canonical-key (%document-key workspace-id id)))
             (unless (tek9:fetch* database canonical-key)
               (incf created))
             (%put-record database canonical-key document)))
         (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+))
    created))

(defun %ensure-default-graph-metadata (database workspace-id)
  (unless (%bounded-range database (%graph-meta-prefix workspace-id) :limit 1)
    (%put-record
     database (%graph-meta-key workspace-id "all-documents")
     (quasar.protocol:json-object
      (cons "id" "all-documents")
      (cons "name" "all-documents")
      (cons "documentIds" :null)
      (cons "positions" (quasar.protocol:empty-object))
      (cons "viewport" :null)
      (cons "layout" "cose")
      (cons "selectedIds" (quasar.protocol:json-array))
      (cons "groups" (quasar.protocol:empty-object))))))

(defun %compact-import-journal (workspace-id stage-id operation-id client
                                base-revision committed-revision document-count
                                byte-count now)
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

(defmethod promote-import-stage ((store tek9-store) workspace-id stage-id operation-id client now)
  (let ((database (tek9-store-database store))
        (outcome nil))
    (tek9:with-write-transaction (database)
      (let* ((meta (%stage-meta-required database workspace-id stage-id))
             (state (or (quasar.protocol:json-value meta "state") "")))
        (cond
          ((string= state "COMMITTED")
           (setf outcome
                 (list :ok
                       (quasar.protocol:json-value meta "committedRevision")
                       (quasar.protocol:json-value meta "documentCount" 0)
                       (or (quasar.protocol:json-value meta "operationId") operation-id))))
          ((not (string= state "OPEN"))
           (%stage-error "import.invalid-session"
                         "The document import session is not open."))
          (t
           (let* ((base-revision (quasar.protocol:json-value meta "baseRevision"))
                  (canonical-meta
                    (tek9:fetch* database (%workspace-meta-key workspace-id)))
                  (current-revision
                    (or (and canonical-meta
                             (quasar.protocol:json-value canonical-meta "revision"))
                        0)))
             (if (/= base-revision current-revision)
                 (progn
                   (quasar.protocol:object-set meta "state" "FAILED")
                   (quasar.protocol:object-set meta "lastActivityAt" now)
                   (quasar.protocol:object-set meta "errorCode"
                                               "workspace.revision-conflict")
                   (%put-record database (%stage-meta-key workspace-id stage-id) meta)
                   (%clear-active-stage-if database workspace-id stage-id)
                   (setf outcome (list :conflict current-revision base-revision)))
                 (let* ((old-count (%canonical-document-count
                                    database workspace-id canonical-meta))
                        (document-count
                          (quasar.protocol:json-value meta "documentCount" 0))
                        (byte-count (quasar.protocol:json-value meta "byteCount" 0))
                        (revision (1+ current-revision)))
                   (quasar.protocol:object-set meta "state" "COMMITTING")
                   (%put-record database (%stage-meta-key workspace-id stage-id) meta)
                   (let ((hook (tek9-store-failure-hook store)))
                     (when hook (funcall hook :before-import-promotion)))
                   (let ((created (%promote-stage-documents
                                   database workspace-id stage-id)))
                     (let ((hook (tek9-store-failure-hook store)))
                       (when hook (funcall hook :before-import-revision)))
                     (let ((next-meta
                             (or (and canonical-meta
                                      (quasar.protocol:clone-json canonical-meta))
                                 (%default-workspace-meta workspace-id 0 old-count))))
                       (quasar.protocol:object-set next-meta "revision" revision)
                       (quasar.protocol:object-set next-meta "documentCount"
                                                   (+ old-count created))
                       (%put-record database (%workspace-meta-key workspace-id)
                                    next-meta))
                     (%ensure-default-graph-metadata database workspace-id)
                     (let ((journal
                             (%compact-import-journal
                              workspace-id stage-id operation-id client
                              base-revision revision document-count byte-count now)))
                       (let ((hook (tek9-store-failure-hook store)))
                         (when hook (funcall hook :before-import-journal)))
                       (%put-record database (%journal-key workspace-id journal) journal))
                     (let ((hook (tek9-store-failure-hook store)))
                       (when hook (funcall hook :before-import-finalize)))
                     (%delete-prefix-bounded database
                                             (%stage-document-prefix workspace-id stage-id))
                     (%delete-prefix-bounded database
                                             (%stage-chunk-prefix workspace-id stage-id))
                     (%clear-active-stage-if database workspace-id stage-id)
                     (quasar.protocol:object-set meta "state" "COMMITTED")
                     (quasar.protocol:object-set meta "committedRevision" revision)
                     (quasar.protocol:object-set meta "operationId" operation-id)
                     (quasar.protocol:object-set meta "lastActivityAt" now)
                     (%put-record database (%stage-meta-key workspace-id stage-id) meta)
                     (setf outcome (list :ok revision document-count operation-id)))))))))))
    (ecase (first outcome)
      (:ok
       (destructuring-bind (status revision document-count committed-operation-id) outcome
         (declare (ignore status))
         (quasar.protocol:json-object
          (cons "sessionId" stage-id)
          (cons "workspaceId" workspace-id)
          (cons "revision" revision)
          (cons "documentCount" document-count)
          (cons "operationId" committed-operation-id))))
      (:conflict
       (destructuring-bind (status current expected) outcome
         (declare (ignore status))
         (%stage-error
          "workspace.revision-conflict"
          (format nil "Workspace ~A is at revision ~D, import expected ~D."
                  workspace-id current expected)))))))

(defmethod abort-import-stage ((store tek9-store) workspace-id stage-id now)
  (declare (ignore now))
  (let ((database (tek9-store-database store)))
    (tek9:with-write-transaction (database)
      (let ((meta (tek9:fetch* database (%stage-meta-key workspace-id stage-id))))
        (when (and meta
                   (string= "COMMITTED"
                            (or (quasar.protocol:json-value meta "state") "")))
          (%stage-error "import.invalid-session"
                        "A committed import cannot be aborted."))
        (%delete-prefix-bounded database (%stage-document-prefix workspace-id stage-id))
        (%delete-prefix-bounded database (%stage-chunk-prefix workspace-id stage-id))
        (%clear-active-stage-if database workspace-id stage-id)
        (when meta
          (tek9:delete-document database (%stage-meta-key workspace-id stage-id)))))
    (quasar.protocol:json-object
     (cons "sessionId" stage-id)
     (cons "aborted" t))))

(defun %stage-expired-p (meta now ttl-seconds)
  (> (- now (or (quasar.protocol:json-value meta "lastActivityAt") now))
     ttl-seconds))

(defmethod cleanup-expired-import-stages ((store tek9-store) now
                                          &key (ttl-seconds +import-stage-ttl-seconds+))
  (let ((database (tek9-store-database store))
        (expired 0)
        (start nil))
    (loop
      for rows = (%bounded-range database (%active-stage-prefix) :start start)
      while rows
      do (dolist (row rows)
           (let* ((pointer (cdr row))
                  (workspace-id (quasar.protocol:json-value pointer "workspaceId"))
                  (stage-id (quasar.protocol:json-value pointer "sessionId"))
                  (meta (and workspace-id stage-id
                             (tek9:fetch* database
                                          (%stage-meta-key workspace-id stage-id)))))
             (when (and meta
                        (string= "OPEN"
                                 (or (quasar.protocol:json-value meta "state") ""))
                        (%stage-expired-p meta now ttl-seconds))
               (abort-import-stage store workspace-id stage-id now)
               (incf expired))))
         (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+))
    expired))