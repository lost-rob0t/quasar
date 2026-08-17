(in-package #:quasar.store)

(defparameter +tek9-schema-version+ 1)
(defparameter +tek9-schema-key+ "quasar/schema")

(define-condition unsupported-storage-schema (error)
  ((found :initarg :found :reader unsupported-storage-schema-found)
   (supported :initarg :supported :reader unsupported-storage-schema-supported))
  (:report (lambda (condition stream)
             (format stream "Quasar Tek9 schema ~S is unsupported; this build supports schema ~D."
                     (unsupported-storage-schema-found condition)
                     (unsupported-storage-schema-supported condition)))))

(defclass workspace-store ()
  ()
  (:documentation
   "Persistence boundary for canonical workspace state. Quasar's actor applies
application semantics first; stores receive validated candidate state and typed
record-level persistence changes."))

(defgeneric load-workspace (store workspace-id)
  (:documentation "Return WORKSPACE-ID or NIL when it has never been persisted."))

(defgeneric save-workspace (store workspace)
  (:documentation
   "Persist a complete workspace explicitly. Normal control-plane mutations use
COMMIT-WORKSPACE and its record-level candidate delta instead."))

(defgeneric append-operation (store workspace-id operation)
  (:documentation "Append one durable journal OPERATION for WORKSPACE-ID."))

(defgeneric commit-workspace (store workspace operation)
  (:documentation
   "Atomically persist WORKSPACE's validated changed records, workspace metadata,
and OPERATION. A failure exposes none of the candidate changes."))

(defgeneric store-journal-entries (store workspace-id)
  (:documentation "Return journal entries for WORKSPACE-ID in revision order."))

(defgeneric close-store (store)
  (:documentation "Release resources owned by STORE."))

(defclass memory-store (workspace-store)
  ((workspaces :initform (make-hash-table :test #'equal)
               :reader memory-store-workspaces)
   (journals :initform (make-hash-table :test #'equal)
             :reader memory-store-journals)
   (lock :initform (bt:make-lock "quasar-memory-store")
         :reader memory-store-lock))
  (:documentation "Focused in-memory implementation used by unit tests."))

(defmethod load-workspace ((store memory-store) workspace-id)
  (bt:with-lock-held ((memory-store-lock store))
    (let ((workspace (gethash workspace-id (memory-store-workspaces store))))
      (and workspace (quasar.workspace:copy-workspace workspace)))))

(defmethod save-workspace ((store memory-store) workspace)
  (bt:with-lock-held ((memory-store-lock store))
    (setf (gethash (quasar.workspace:workspace-id workspace)
                   (memory-store-workspaces store))
          (quasar.workspace:copy-workspace workspace)))
  workspace)

(defmethod append-operation ((store memory-store) workspace-id operation)
  (bt:with-lock-held ((memory-store-lock store))
    (let ((journal (gethash workspace-id (memory-store-journals store))))
      (unless journal
        (setf journal (make-array 0 :adjustable t :fill-pointer 0)
              (gethash workspace-id (memory-store-journals store)) journal))
      (vector-push-extend (quasar.protocol:clone-json operation) journal)))
  operation)

(defmethod commit-workspace ((store memory-store) workspace operation)
  (bt:with-lock-held ((memory-store-lock store))
    (let* ((workspace-id (quasar.workspace:workspace-id workspace))
           (journal (or (gethash workspace-id (memory-store-journals store))
                        (make-array 0 :adjustable t :fill-pointer 0)))
           (next-journal (make-array (length journal)
                                     :adjustable t :fill-pointer (length journal))))
      (replace next-journal journal)
      (vector-push-extend (quasar.protocol:clone-json operation) next-journal)
      (setf (gethash workspace-id (memory-store-workspaces store))
            (quasar.workspace:copy-workspace workspace)
            (gethash workspace-id (memory-store-journals store)) next-journal)))
  (quasar.workspace:clear-workspace-persistence-changes workspace)
  workspace)

(defmethod store-journal-entries ((store memory-store) workspace-id)
  (bt:with-lock-held ((memory-store-lock store))
    (let ((journal (gethash workspace-id (memory-store-journals store))))
      (when journal
        (map 'list #'quasar.protocol:clone-json journal)))))

(defmethod close-store ((store memory-store))
  store)

(defun make-memory-store ()
  (make-instance 'memory-store))

(defun default-tek9-path ()
  "Return Quasar's production XDG data path for its embedded Tek9 database."
  (let ((xdg (uiop:getenv "XDG_DATA_HOME")))
    (if (and xdg (plusp (length xdg)))
        (merge-pathnames #P"quasar/tek9/"
                         (uiop:ensure-directory-pathname xdg))
        (merge-pathnames #P".local/share/quasar/tek9/"
                         (user-homedir-pathname)))))

(defclass tek9-store (workspace-store)
  ((path :initarg :path :reader tek9-store-path)
   (database :initarg :database :reader tek9-store-database)
   (failure-hook :initarg :failure-hook :initform nil
                 :accessor tek9-store-failure-hook)
   (last-commit-stats :initform nil :accessor tek9-store-last-commit-stats))
  (:documentation
   "Process-durable Quasar store. One Tek9/LMDB environment remains open for
the store lifetime; canonical data uses Tek9's full durability profile."))

(defun %key-part (value)
  (let ((string (princ-to-string value)))
    (format nil "~D:~A" (length string) string)))

(defun %workspace-prefix (workspace-id)
  (format nil "quasar/v1/ws/~A/" (%key-part workspace-id)))

(defun %workspace-meta-key (workspace-id)
  (concatenate 'string (%workspace-prefix workspace-id) "meta"))

(defun %document-prefix (workspace-id)
  (concatenate 'string (%workspace-prefix workspace-id) "doc/"))

(defun %document-key (workspace-id document-id)
  (concatenate 'string (%document-prefix workspace-id) (%key-part document-id)))

(defun %graph-meta-prefix (workspace-id)
  (concatenate 'string (%workspace-prefix workspace-id) "graph/"))

(defun %graph-meta-key (workspace-id graph-id)
  (concatenate 'string (%graph-meta-prefix workspace-id) (%key-part graph-id)))

(defun %node-prefix (workspace-id graph-id)
  (format nil "~Anode/~A/" (%workspace-prefix workspace-id) (%key-part graph-id)))

(defun %node-key (workspace-id graph-id node-id)
  (concatenate 'string (%node-prefix workspace-id graph-id) (%key-part node-id)))

(defun %edge-prefix (workspace-id graph-id)
  (format nil "~Aedge/~A/" (%workspace-prefix workspace-id) (%key-part graph-id)))

(defun %edge-key (workspace-id graph-id edge-id)
  (concatenate 'string (%edge-prefix workspace-id graph-id) (%key-part edge-id)))

(defun %journal-prefix (workspace-id)
  (concatenate 'string (%workspace-prefix workspace-id) "journal/"))

(defun %journal-key (workspace-id operation)
  (let* ((revision (or (quasar.protocol:json-value operation "committedRevision") 0))
         (id (or (quasar.protocol:json-value operation "operationId")
                 (quasar.protocol:json-value operation "transactionId")
                 (format nil "entry-~D" revision))))
    (format nil "~A~20,'0D/~A" (%journal-prefix workspace-id)
            revision (%key-part id))))

(defun %graph-namespace (workspace-id graph-id)
  (format nil "quasar/~A/~A" (%key-part workspace-id) (%key-part graph-id)))

(defun %prefix-end (prefix)
  "Return an exclusive lexical successor for an ASCII PREFIX ending in slash."
  (assert (char= (char prefix (1- (length prefix))) #\/))
  (concatenate 'string (subseq prefix 0 (1- (length prefix))) "0"))

(defun %range-values (database prefix)
  (loop for (key . value)
          in (tek9:select-primary-range database prefix :end (%prefix-end prefix))
        while (and (<= (length prefix) (length key))
                   (string= prefix key :end2 (length prefix)))
        collect value))

(defun %range-keys (database prefix)
  (loop for entry in (tek9:select-primary-range
                      database prefix :end (%prefix-end prefix))
        for key = (car entry)
        while (and (<= (length prefix) (length key))
                   (string= prefix key :end2 (length prefix)))
        collect key))

(defun %put-record (database key value)
  ;; PUT-BULK with TRACK-CHANGES disabled avoids growing Tek9's materialized-view
  ;; change vector for Quasar's ordinary canonical writes.
  (tek9:put-bulk database
                 (list (tek9:new-document :id key
                                          :value (quasar.protocol:clone-json value)))))

(defun %delete-prefix (database prefix)
  (dolist (key (%range-keys database prefix))
    (tek9:delete-document database key)))

(defun %graph-metadata (graph)
  (cons :obj
        (loop for (key . value) in (rest graph)
              unless (member key '("nodes" "edges") :test #'string=)
                collect (cons key (quasar.protocol:clone-json value)))))

(defun %workspace-settings-object (workspace)
  (apply #'quasar.protocol:json-object
         (loop for key being the hash-keys of (quasar.workspace:workspace-settings workspace)
               using (hash-value value)
               collect (cons key (quasar.protocol:clone-json value)))))

(defun %workspace-meta (workspace)
  (quasar.protocol:json-object
   (cons "storageSchemaVersion" +tek9-schema-version+)
   (cons "workspaceId" (quasar.workspace:workspace-id workspace))
   (cons "revision" (quasar.workspace:workspace-revision workspace))
   (cons "activeGraphId"
         (or (gethash "activeGraphId" (quasar.workspace:workspace-settings workspace))
             "all-documents"))
   (cons "settings" (%workspace-settings-object workspace))))

(defun %ensure-supported-schema (database)
  (let* ((stored (tek9:fetch* database +tek9-schema-key+))
         (version (and stored (quasar.protocol:json-value stored "version"))))
    (cond
      ((null stored)
       (%put-record database +tek9-schema-key+
                    (quasar.protocol:json-object
                     (cons "version" +tek9-schema-version+))))
      ((eql version +tek9-schema-version+)
       t)
      (t
       (error 'unsupported-storage-schema
              :found version
              :supported +tek9-schema-version+)))))

(defun make-tek9-store (&key (path (default-tek9-path)) failure-hook)
  "Open one full-durability Tek9 environment for Quasar at PATH."
  (let* ((path (uiop:ensure-directory-pathname path))
         (database (tek9:open-database
                    (tek9:new-database "quasar"
                                       :path path
                                       :durability :full))))
    (handler-case
        (progn
          (%ensure-supported-schema database)
          (make-instance 'tek9-store
                         :path path
                         :database database
                         :failure-hook failure-hook))
      (error (condition)
        (tek9:close-database database)
        (error condition)))))

(defmethod close-store ((store tek9-store))
  (when (tek9:db-is-open-p (tek9-store-database store))
    (tek9:close-database (tek9-store-database store)))
  store)

(defun %restore-settings (workspace settings)
  (clrhash (quasar.workspace:workspace-settings workspace))
  (when (quasar.protocol:object-p settings)
    (dolist (pair (rest settings))
      (setf (gethash (car pair) (quasar.workspace:workspace-settings workspace))
            (quasar.protocol:clone-json (cdr pair)))))
  workspace)

(defun %restore-graph (store workspace metadata)
  (let* ((database (tek9-store-database store))
         (workspace-id (quasar.workspace:workspace-id workspace))
         (graph-id (quasar.protocol:json-value metadata "id"))
         (namespace (%graph-namespace workspace-id graph-id))
         (graph (quasar.protocol:clone-json metadata))
         (nodes
           (loop for topology-node in (tek9:fetch-graph-nodes database namespace)
                 for node-id = (tek9:node-id topology-node)
                 for canonical = (tek9:fetch* database
                                               (%node-key workspace-id graph-id node-id))
                 do (unless canonical
                      (error "Tek9 graph ~A node ~A has no Quasar canonical sidecar."
                             graph-id node-id))
                 collect (quasar.protocol:clone-json canonical)))
         (edges
           (loop for topology-edge in (tek9:fetch-graph-edges database namespace)
                 for edge-id = (tek9:edge-id topology-edge)
                 for canonical = (tek9:fetch* database
                                               (%edge-key workspace-id graph-id edge-id))
                 do (unless canonical
                      (error "Tek9 graph ~A edge ~A has no Quasar canonical sidecar."
                             graph-id edge-id))
                 collect (quasar.protocol:clone-json canonical))))
    (quasar.protocol:object-set graph "nodes"
                                (apply #'quasar.protocol:json-array nodes))
    (quasar.protocol:object-set graph "edges"
                                (apply #'quasar.protocol:json-array edges))
    (setf (quasar.workspace:workspace-graph workspace graph-id) graph)
    graph))

(defmethod load-workspace ((store tek9-store) workspace-id)
  (let* ((database (tek9-store-database store))
         (meta (tek9:fetch* database (%workspace-meta-key workspace-id))))
    (unless meta
      (return-from load-workspace nil))
    (let ((schema (quasar.protocol:json-value meta "storageSchemaVersion")))
      (unless (eql schema +tek9-schema-version+)
        (error 'unsupported-storage-schema
               :found schema :supported +tek9-schema-version+)))
    (let ((workspace (quasar.workspace:make-workspace :id workspace-id)))
      (setf (quasar.workspace:workspace-revision workspace)
            (quasar.protocol:json-value meta "revision" 0))
      (%restore-settings workspace
                         (or (quasar.protocol:json-value meta "settings")
                             (quasar.protocol:empty-object)))
      (unless (gethash "activeGraphId" (quasar.workspace:workspace-settings workspace))
        (setf (gethash "activeGraphId" (quasar.workspace:workspace-settings workspace))
              (or (quasar.protocol:json-value meta "activeGraphId")
                  "all-documents")))
      (dolist (document (%range-values database (%document-prefix workspace-id)))
        (setf (gethash (quasar.protocol:json-value document "_id")
                       (quasar.workspace:workspace-documents workspace))
              (quasar.protocol:clone-json document)))
      (dolist (graph-meta (%range-values database (%graph-meta-prefix workspace-id)))
        (%restore-graph store workspace graph-meta))
      (let ((journal (quasar.workspace:workspace-journal workspace)))
        (dolist (entry (store-journal-entries store workspace-id))
          (vector-push-extend (quasar.protocol:clone-json entry) journal)))
      workspace)))

(defun %put-node (database workspace-id graph-id canonical)
  (let ((node-id (quasar.protocol:json-value canonical "id"))
        (namespace (%graph-namespace workspace-id graph-id)))
    (%put-record database (%node-key workspace-id graph-id node-id) canonical)
    (tek9:put-node database
                   (make-instance 'tek9:node
                                  :id node-id
                                  :props (quasar.protocol:clone-json canonical))
                   :database-name namespace)))

(defun %put-edge (database workspace-id graph-id canonical)
  (let ((edge-id (quasar.protocol:json-value canonical "id"))
        (namespace (%graph-namespace workspace-id graph-id)))
    (%put-record database (%edge-key workspace-id graph-id edge-id) canonical)
    (tek9:put-edge database
                   (make-instance 'tek9:edge
                                  :id edge-id
                                  :source (quasar.protocol:json-value canonical "source")
                                  :predicate (or (quasar.protocol:json-value canonical "predicate")
                                                 "related")
                                  :target (quasar.protocol:json-value canonical "target"))
                   :database-name namespace)))

(defun %delete-edge (database workspace-id graph-id edge-id)
  (let* ((namespace (%graph-namespace workspace-id graph-id))
         (edge (tek9:fetch-edge database edge-id :database-name namespace)))
    (when edge
      (tek9:delete-edge database edge :database-name namespace))
    (tek9:delete-document database (%edge-key workspace-id graph-id edge-id))))

(defun %replace-graph (database workspace-id graph-id graph)
  (let ((namespace (%graph-namespace workspace-id graph-id)))
    (tek9:clear-graph database namespace)
    (%delete-prefix database (%node-prefix workspace-id graph-id))
    (%delete-prefix database (%edge-prefix workspace-id graph-id))
    (%put-record database (%graph-meta-key workspace-id graph-id)
                 (%graph-metadata graph))
    (dolist (node (quasar.workspace:array-elements
                   (quasar.workspace:graph-nodes graph)))
      (%put-node database workspace-id graph-id node))
    (dolist (edge (quasar.workspace:array-elements
                   (quasar.workspace:graph-edges graph)))
      (%put-edge database workspace-id graph-id edge))))

(defun %delete-graph (database workspace-id graph-id)
  (tek9:clear-graph database (%graph-namespace workspace-id graph-id))
  (%delete-prefix database (%node-prefix workspace-id graph-id))
  (%delete-prefix database (%edge-prefix workspace-id graph-id))
  (tek9:delete-document database (%graph-meta-key workspace-id graph-id)))

(defun %fresh-commit-stats ()
  (list :document-upserts 0
        :document-deletes 0
        :graph-metadata-upserts 0
        :graph-replacements 0
        :graph-deletes 0
        :node-upserts 0
        :node-deletes 0
        :edge-upserts 0
        :edge-deletes 0))

(defun %inc-stat (stats key)
  (incf (getf stats key))
  stats)

(defun %apply-change (store workspace-id change stats)
  (let* ((database (tek9-store-database store))
         (kind (quasar.workspace:persistence-change-kind change))
         (graph-id (quasar.workspace:persistence-change-graph-id change))
         (id (quasar.workspace:persistence-change-id change))
         (value (quasar.workspace:persistence-change-value change)))
    (ecase kind
      (:document-upsert
       (%put-record database (%document-key workspace-id id) value)
       (%inc-stat stats :document-upserts))
      (:document-delete
       (tek9:delete-document database (%document-key workspace-id id))
       (%inc-stat stats :document-deletes))
      (:graph-metadata-upsert
       (%put-record database (%graph-meta-key workspace-id graph-id)
                    (%graph-metadata value))
       (%inc-stat stats :graph-metadata-upserts))
      (:graph-replace
       (%replace-graph database workspace-id graph-id value)
       (%inc-stat stats :graph-replacements))
      (:graph-delete
       (%delete-graph database workspace-id graph-id)
       (%inc-stat stats :graph-deletes))
      (:node-upsert
       (%put-node database workspace-id graph-id value)
       (%inc-stat stats :node-upserts))
      (:node-delete
       (tek9:delete-node database id
                         :database-name (%graph-namespace workspace-id graph-id))
       (tek9:delete-document database (%node-key workspace-id graph-id id))
       (%inc-stat stats :node-deletes))
      (:edge-upsert
       (%put-edge database workspace-id graph-id value)
       (%inc-stat stats :edge-upserts))
      (:edge-delete
       (%delete-edge database workspace-id graph-id id)
       (%inc-stat stats :edge-deletes)))
    stats))

(defun %stored-revision (database workspace-id)
  (let ((meta (tek9:fetch* database (%workspace-meta-key workspace-id))))
    (and meta (quasar.protocol:json-value meta "revision"))))

(defun %assert-base-revision (database workspace-id operation)
  (let ((expected (quasar.protocol:json-value operation "baseRevision"))
        (stored (%stored-revision database workspace-id)))
    (when (and expected
               (not (= expected (or stored 0))))
      (error 'quasar.protocol:quasar-error
             :code "workspace.revision-conflict"
             :message (format nil "Tek9 workspace ~A is at revision ~A, expected ~A."
                              workspace-id (or stored 0) expected)))))

(defun %ensure-new-workspace-graph-metadata (database workspace)
  (let ((workspace-id (quasar.workspace:workspace-id workspace)))
    (unless (tek9:fetch* database (%workspace-meta-key workspace-id))
      (loop for graph-id being the hash-keys of (quasar.workspace:workspace-graphs workspace)
            using (hash-value graph)
            do (%put-record database (%graph-meta-key workspace-id graph-id)
                            (%graph-metadata graph))))))

(defmethod commit-workspace ((store tek9-store) workspace operation)
  (let* ((database (tek9-store-database store))
         (workspace-id (quasar.workspace:workspace-id workspace))
         (stats (%fresh-commit-stats)))
    (tek9:with-write-transaction (database)
      (%assert-base-revision database workspace-id operation)
      (%ensure-new-workspace-graph-metadata database workspace)
      (loop for change across (quasar.workspace:workspace-persistence-changes workspace)
            do (%apply-change store workspace-id change stats))
      (%put-record database (%workspace-meta-key workspace-id)
                   (%workspace-meta workspace))
      (%put-record database (%journal-key workspace-id operation) operation)
      (let ((hook (tek9-store-failure-hook store)))
        (when hook
          (funcall hook :before-commit))))
    (setf (tek9-store-last-commit-stats store) stats)
    (quasar.workspace:clear-workspace-persistence-changes workspace)
    workspace))

(defmethod append-operation ((store tek9-store) workspace-id operation)
  (tek9:with-write-transaction ((tek9-store-database store))
    (%put-record (tek9-store-database store)
                 (%journal-key workspace-id operation)
                 operation))
  operation)

(defmethod store-journal-entries ((store tek9-store) workspace-id)
  (mapcar #'quasar.protocol:clone-json
          (%range-values (tek9-store-database store)
                         (%journal-prefix workspace-id))))

(defun %full-workspace-changes (workspace)
  (let ((changes nil))
    (loop for id being the hash-keys of (quasar.workspace:workspace-documents workspace)
          using (hash-value document)
          do (push (quasar.workspace:make-persistence-change
                    :kind :document-upsert :id id
                    :value (quasar.protocol:clone-json document))
                   changes))
    (loop for graph-id being the hash-keys of (quasar.workspace:workspace-graphs workspace)
          using (hash-value graph)
          do (push (quasar.workspace:make-persistence-change
                    :kind :graph-replace :graph-id graph-id :id graph-id
                    :value (quasar.protocol:clone-json graph))
                   changes))
    (nreverse changes)))

(defmethod save-workspace ((store tek9-store) workspace)
  "Explicit full bootstrap/migration write; not used by normal mutations."
  (let* ((database (tek9-store-database store))
         (workspace-id (quasar.workspace:workspace-id workspace))
         (prefix (%workspace-prefix workspace-id)))
    (tek9:with-write-transaction (database)
      ;; This explicit API is allowed to replace one complete workspace. Normal
      ;; COMMIT-WORKSPACE never calls this path.
      (%delete-prefix database prefix)
      (dolist (change (%full-workspace-changes workspace))
        (%apply-change store workspace-id change (%fresh-commit-stats)))
      (%put-record database (%workspace-meta-key workspace-id)
                   (%workspace-meta workspace))))
  workspace)
