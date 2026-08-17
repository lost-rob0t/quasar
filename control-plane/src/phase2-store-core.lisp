(in-package #:quasar.store)

(defparameter +phase2-range-batch-size+ 128)
(defparameter +import-max-chunk-bytes+ (* 1024 1024))
(defparameter +import-max-operations-per-chunk+ 1000)
(defparameter +import-stage-ttl-seconds+ (* 24 60 60))

(defgeneric direct-document (store workspace-id document-id)
  (:documentation
   "Fetch one canonical document without materializing its workspace."))

(defgeneric direct-document-list (store workspace-id)
  (:documentation
   "Fetch canonical documents directly from the store in stable key order."))

(defgeneric direct-workspace-snapshot-page
    (store workspace-id offset byte-limit)
  (:documentation
   "Return one bounded document page plus durable workspace/graph metadata."))

(defgeneric begin-import-stage
    (store workspace-id stage-id base-revision now)
  (:documentation "Create one durable OPEN import stage."))

(defgeneric accept-import-chunk
    (store workspace-id stage-id sequence operations now)
  (:documentation
   "Atomically validate and durably accept one sequenced import chunk."))

(defgeneric promote-import-stage
    (store workspace-id stage-id operation-id client now)
  (:documentation
   "Atomically promote one durable stage into canonical workspace state."))

(defgeneric abort-import-stage (store workspace-id stage-id now)
  (:documentation
   "Idempotently abort and remove one durable import stage."))

(defgeneric cleanup-expired-import-stages
    (store now &key ttl-seconds)
  (:documentation
   "Remove expired OPEN stages without scanning unrelated canonical records."))

(defmethod direct-document
    ((store memory-store) workspace-id document-id)
  (let ((workspace (load-workspace store workspace-id)))
    (and workspace
         (let ((document
                 (gethash
                  document-id
                  (quasar.workspace:workspace-documents workspace))))
           (and document
                (quasar.protocol:clone-json document))))))

(defmethod direct-document-list ((store memory-store) workspace-id)
  (let ((workspace (load-workspace store workspace-id)))
    (when workspace
      (sort
       (loop for document being the hash-values
               of (quasar.workspace:workspace-documents workspace)
             collect (quasar.protocol:clone-json document))
       #'string<
       :key
       (lambda (document)
         (quasar.protocol:json-value document "_id"))))))

(defmethod direct-workspace-snapshot-page
    ((store memory-store) workspace-id offset byte-limit)
  (let ((workspace
          (or (load-workspace store workspace-id)
              (quasar.workspace:make-workspace :id workspace-id))))
    (quasar.workspace:workspace-snapshot-page
     workspace offset byte-limit)))

(defun streaming-store-p (store)
  (typep store 'tek9-store))

(defun %stage-root-prefix ()
  "quasar/v1/stage/")

(defun %stage-workspace-prefix (workspace-id)
  (format nil "~A~A/" (%stage-root-prefix) (%key-part workspace-id)))

(defun %stage-prefix (workspace-id stage-id)
  (format nil
          "~A~A/"
          (%stage-workspace-prefix workspace-id)
          (%key-part stage-id)))

(defun %stage-meta-key (workspace-id stage-id)
  (concatenate 'string (%stage-prefix workspace-id stage-id) "meta"))

(defun %stage-document-prefix (workspace-id stage-id)
  (concatenate 'string (%stage-prefix workspace-id stage-id) "doc/"))

(defun %stage-document-key (workspace-id stage-id document-id)
  (concatenate
   'string
   (%stage-document-prefix workspace-id stage-id)
   (%key-part document-id)))

(defun %stage-chunk-prefix (workspace-id stage-id)
  (concatenate 'string (%stage-prefix workspace-id stage-id) "chunk/"))

(defun %stage-chunk-key (workspace-id stage-id sequence)
  (format nil
          "~A~20,'0D"
          (%stage-chunk-prefix workspace-id stage-id)
          sequence))

(defun %active-stage-prefix ()
  "quasar/v1/stage-active/")

(defun %active-stage-key (workspace-id)
  (concatenate
   'string
   (%active-stage-prefix)
   (%key-part workspace-id)))

(defun %prefix-p (prefix key)
  (and (<= (length prefix) (length key))
       (string= prefix key :end2 (length prefix))))

(defun %bounded-range
    (database prefix &key start (limit +phase2-range-batch-size+))
  "Return at most LIMIT rows in PREFIX after START using one ordered seek."
  (let* ((seek (or start prefix))
         (raw
           (tek9:select-primary-range
            database
            seek
            :end (%prefix-end prefix)
            :limit (if start (1+ limit) limit)))
         (rows
           (loop for row in raw
                 while (%prefix-p prefix (car row))
                 unless
                   (and start (string= (car row) start))
                   collect row)))
    (if (> (length rows) limit)
        (subseq rows 0 limit)
        rows)))

(defun %delete-prefix-bounded (database prefix)
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
  (length
   (babel:string-to-octets string :encoding :utf-8)))

(defun %fnv1a-64 (string)
  "Stable non-cryptographic content digest used only for replay identity."
  (let ((hash #xcbf29ce484222325))
    (loop
      for octet across
        (babel:string-to-octets string :encoding :utf-8)
      do
        (setf hash
              (logand
               #xffffffffffffffff
               (* (logxor hash octet) #x100000001b3))))
    (format nil "~16,'0X" hash)))

(defun %stage-error
    (code message
     &optional (details (quasar.protocol:empty-object)))
  (error
   'quasar.protocol:quasar-error
   :code code
   :message message
   :details details))

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
  (or
   (tek9:fetch*
    database (%stage-meta-key workspace-id stage-id))
   (%stage-error
    "import.invalid-session"
    "The document import session does not exist.")))

(defun %stage-open-required (database workspace-id stage-id)
  (let ((meta (%stage-meta-required database workspace-id stage-id)))
    (unless
        (string=
         "OPEN"
         (or (quasar.protocol:json-value meta "state") ""))
      (%stage-error
       "import.invalid-session"
       "The document import session is not open."))
    meta))

(defun %active-stage-id (database workspace-id)
  (let ((record
          (tek9:fetch*
           database (%active-stage-key workspace-id))))
    (and record
         (quasar.protocol:json-value record "sessionId"))))

(defun %put-active-stage (database workspace-id stage-id)
  (%put-record
   database
   (%active-stage-key workspace-id)
   (quasar.protocol:json-object
    (cons "workspaceId" workspace-id)
    (cons "sessionId" stage-id))))

(defun %clear-active-stage-if (database workspace-id stage-id)
  (let ((active (%active-stage-id database workspace-id)))
    (when (and active (string= active stage-id))
      (tek9:delete-document
       database (%active-stage-key workspace-id)))))

(defun %default-workspace-meta
    (workspace-id revision document-count)
  (quasar.protocol:json-object
   (cons "storageSchemaVersion" +tek9-schema-version+)
   (cons "workspaceId" workspace-id)
   (cons "revision" revision)
   (cons "documentCount" document-count)
   (cons "activeGraphId" "all-documents")
   (cons
    "settings"
    (quasar.protocol:json-object
     (cons "activeGraphId" "all-documents")))))

(defun %workspace-meta-with-document-count (workspace)
  (quasar.protocol:json-object
   (cons "storageSchemaVersion" +tek9-schema-version+)
   (cons "workspaceId" (quasar.workspace:workspace-id workspace))
   (cons "revision" (quasar.workspace:workspace-revision workspace))
   (cons
    "documentCount"
    (hash-table-count
     (quasar.workspace:workspace-documents workspace)))
   (cons
    "activeGraphId"
    (or
     (gethash
      "activeGraphId"
      (quasar.workspace:workspace-settings workspace))
     "all-documents"))
   (cons "settings" (%workspace-settings-object workspace))))

(defun %workspace-meta (workspace)
  (%workspace-meta-with-document-count workspace))

(defmethod direct-document
    ((store tek9-store) workspace-id document-id)
  (let ((document
          (tek9:fetch*
           (tek9-store-database store)
           (%document-key workspace-id document-id))))
    (and document
         (quasar.protocol:clone-json document))))

(defmethod direct-document-list ((store tek9-store) workspace-id)
  (mapcar
   #'quasar.protocol:clone-json
   (%range-values
    (tek9-store-database store)
    (%document-prefix workspace-id))))

(defun %restore-metadata-workspace (store workspace-id meta)
  (let ((workspace
          (quasar.workspace:make-workspace :id workspace-id)))
    (clrhash (quasar.workspace:workspace-graphs workspace))
    (setf
     (quasar.workspace:workspace-revision workspace)
     (or (quasar.protocol:json-value meta "revision") 0))
    (%restore-settings
     workspace
     (or
      (quasar.protocol:json-value meta "settings")
      (quasar.protocol:empty-object)))
    (unless
        (gethash
         "activeGraphId"
         (quasar.workspace:workspace-settings workspace))
      (setf
       (gethash
        "activeGraphId"
        (quasar.workspace:workspace-settings workspace))
       (or
        (quasar.protocol:json-value meta "activeGraphId")
        "all-documents")))
    (dolist
        (graph-meta
         (%range-values
          (tek9-store-database store)
          (%graph-meta-prefix workspace-id)))
      (%restore-graph store workspace graph-meta))
    (when
        (zerop
         (hash-table-count
          (quasar.workspace:workspace-graphs workspace)))
      (let ((graph
              (quasar.protocol:json-object
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
        (setf
         (quasar.workspace:workspace-graph
          workspace "all-documents")
         graph)))
    workspace))

(defun %settings-json (workspace)
  (apply
   #'quasar.protocol:json-object
   (loop
     for key being the hash-keys
       of (quasar.workspace:workspace-settings workspace)
     using (hash-value value)
     collect
       (cons key (quasar.protocol:clone-json value)))))

(defun %graphs-json (workspace)
  (apply
   #'quasar.protocol:json-array
   (sort
    (loop
      for graph being the hash-values
        of (quasar.workspace:workspace-graphs workspace)
      collect (quasar.protocol:clone-json graph))
    #'string<
    :key
    (lambda (graph)
      (quasar.protocol:json-value graph "id")))))