(in-package #:quasar.store)

(defconstant +quota-version+ 2)
(defparameter +quota-migration-key+ "quasar/v1/quota-migration")

(defun %json-octet-count (value)
  (length (babel:string-to-octets (quasar.protocol:encode value) :encoding :utf-8)))

(defun %quota-key (workspace-id)
  (format nil "quasar/v1/quota/~A" (%key-part workspace-id)))

(defun %quota-graph-key (workspace-id graph-id)
  (format nil "quasar/v1/quota-graph/~A/~A" (%key-part workspace-id) (%key-part graph-id)))

(defun %quota-array-sum (items)
  (loop for item in items sum (1+ (%json-octet-count item))))

(defun %quota-range-sum (database prefix)
  "Migration-only scan: retain a range batch, not a corpus."
  (let ((sum 0) (count 0))
    (%map-prefix-bounded database prefix
     (lambda (row) (incf sum (1+ (%json-octet-count (cdr row)))) (incf count)))
    (values sum count)))

(defun %quota-graph-counter (database workspace-id graph-id)
  (let ((counter (tek9:fetch* database (%quota-graph-key workspace-id graph-id))))
    (cond (counter (quasar.protocol:clone-json counter))
          ((not (tek9:fetch* database (%graph-meta-key workspace-id graph-id)))
           (quasar.protocol:json-object (cons "nodeSum" 0) (cons "edgeSum" 0)))
          (t (error 'quasar.protocol:quasar-error :code "storage.accounting-required"
                    :message "Graph accounting is missing; reopen with quota migration.")))))

(defun %quota-graph-size (database workspace-id graph-id)
  (let ((metadata (tek9:fetch* database (%graph-meta-key workspace-id graph-id))))
    (when metadata
      (let ((counter (%quota-graph-counter database workspace-id graph-id)))
        (+ (%json-octet-count (%graph-with-empty-topology metadata))
           (max 0 (1- (quasar.protocol:json-value counter "nodeSum")))
           (max 0 (1- (quasar.protocol:json-value counter "edgeSum"))))))))

(defun %quota-graph-from-json (graph)
  (quasar.protocol:json-object
   (cons "nodeSum" (%quota-array-sum (quasar.workspace:array-elements
                                     (quasar.workspace:graph-nodes graph))))
   (cons "edgeSum" (%quota-array-sum (quasar.workspace:array-elements
                                     (quasar.workspace:graph-edges graph))))))

(defun %quota-ensure-default-graph (database workspace-id)
  ;; Only insertion creates a counter; never cover up missing accounting for
  ;; an existing graph. Ordinary commits do not scan topology.
  (unless (%bounded-range database (%graph-meta-prefix workspace-id) :limit 1)
    (%ensure-default-graph-metadata database workspace-id)
    (%put-record database (%quota-graph-key workspace-id "all-documents")
                 (quasar.protocol:json-object (cons "nodeSum" 0) (cons "edgeSum" 0)))))

(defun %quota-baseline (database workspace-id revision)
  "One-time startup migration, outside ordinary commands and import promotion."
  (multiple-value-bind (document-sum document-count)
      (%quota-range-sum database (%document-prefix workspace-id))
    (let ((graph-sum 0))
      (%map-prefix-bounded database (%graph-meta-prefix workspace-id)
       (lambda (row)
         (let ((graph-id (quasar.protocol:json-value (cdr row) "id")))
           (%put-record database (%quota-graph-key workspace-id graph-id)
            (quasar.protocol:json-object
             (cons "nodeSum" (%quota-range-sum database (%node-prefix workspace-id graph-id)))
             (cons "edgeSum" (%quota-range-sum database (%edge-prefix workspace-id graph-id)))))
           (incf graph-sum (1+ (%quota-graph-size database workspace-id graph-id))))))
      (values
       (quasar.protocol:json-object
        (cons "version" +quota-version+) (cons "revision" revision)
        (cons "documentSum" document-sum) (cons "graphSum" graph-sum))
       document-count))))

(defun migrate-quota-accounting (store &key force)
  "Atomically upgrade legacy accounting once before admitting commands.
A failed upgrade leaves no marker or partial counters. Subsequent opens read
only the marker. Downgrade writers are unsupported: stale counters fail closed."
  (let* ((database (tek9-store-database store))
         (marker (tek9:fetch* database +quota-migration-key+)))
    (unless (and (not force) (eql +quota-version+ (quasar.protocol:json-value marker "version")))
      (tek9:with-write-transaction (database)
        (%map-prefix-bounded database "quasar/v1/ws/"
         (lambda (row)
           (let* ((metadata (cdr row))
                  (id (quasar.protocol:json-value metadata "workspaceId")))
             (when (and (stringp id) (equal (car row) (%workspace-meta-key id)))
               (multiple-value-bind (state count)
                   (%quota-baseline database id (quasar.protocol:json-value metadata "revision" 0))
                 (%put-record database (%quota-key id) state)
                 (quasar.protocol:object-set metadata "documentCount" count)
                 (%put-record database (car row) metadata))))))
        (%run-mutation-hook store :before-quota-migration-commit)
        (%put-record database +quota-migration-key+
                     (quasar.protocol:json-object (cons "version" +quota-version+))))))
  store)

(defmethod initialize-instance :after ((store tek9-store) &key)
  ;; MAKE-TEK9-STORE closes the database if initialization/migration signals.
  (migrate-quota-accounting store))

(defun %quota-state (database workspace-id revision)
  (let ((state (tek9:fetch* database (%quota-key workspace-id))))
    (cond
      ((and state (eql +quota-version+ (quasar.protocol:json-value state "version"))
            (eql revision (quasar.protocol:json-value state "revision")))
       (quasar.protocol:clone-json state))
      ((and (null state) (null (tek9:fetch* database (%workspace-meta-key workspace-id))))
       (quasar.protocol:json-object
        (cons "version" +quota-version+) (cons "revision" 0)
        (cons "documentSum" 0)
        (cons "graphSum" (1+ (%quota-graph-size database workspace-id "all-documents")))))
      (t (error 'quasar.protocol:quasar-error :code "storage.accounting-required"
                :message "Workspace accounting is stale; an explicit migration is required.")))))

(defun %quota-record-delta (previous next)
  (- (if next (1+ (%json-octet-count next)) 0)
     (if previous (1+ (%json-octet-count previous)) 0)))

(defun %quota-document-delta (database workspace-id change)
  (when (member (quasar.workspace:persistence-change-kind change)
                '(:document-upsert :document-delete))
    (%quota-record-delta
     (tek9:fetch* database (%document-key workspace-id (quasar.workspace:persistence-change-id change)))
     (and (eq :document-upsert (quasar.workspace:persistence-change-kind change))
          (quasar.workspace:persistence-change-value change)))))

(defun %quota-track-graph-change (database workspace-id change)
  "Update counters from the old sidecar and the explicit typed change only."
  (let* ((kind (quasar.workspace:persistence-change-kind change))
         (graph-id (quasar.workspace:persistence-change-graph-id change))
         (id (quasar.workspace:persistence-change-id change))
         (value (quasar.workspace:persistence-change-value change)))
    (when graph-id
      (case kind
        (:graph-delete (tek9:delete-document database (%quota-graph-key workspace-id graph-id)))
        (:graph-replace
         (%put-record database (%quota-graph-key workspace-id graph-id) (%quota-graph-from-json value)))
        (otherwise
         (let ((counter (%quota-graph-counter database workspace-id graph-id)))
           (when (member kind '(:node-upsert :node-delete :edge-upsert :edge-delete))
             (let* ((node-p (member kind '(:node-upsert :node-delete)))
                    (field (if node-p "nodeSum" "edgeSum"))
                    (previous (tek9:fetch* database
                               (if node-p (%node-key workspace-id graph-id id)
                                   (%edge-key workspace-id graph-id id))))
                    (next (and (member kind '(:node-upsert :edge-upsert)) value)))
               (quasar.protocol:object-set counter field
                (+ (quasar.protocol:json-value counter field) (%quota-record-delta previous next)))))
           (%put-record database (%quota-graph-key workspace-id graph-id) counter)))))))

(defun %quota-snapshot-size (workspace-id revision settings state)
  (+ (%json-octet-count
      (quasar.protocol:json-object
       (cons "id" workspace-id) (cons "revision" revision)
       (cons "documents" (quasar.protocol:json-array))
       (cons "graphs" (quasar.protocol:json-array))
       (cons "activeGraphId" (or (quasar.protocol:json-value settings "activeGraphId") "all-documents"))
       (cons "settings" settings)))
     (max 0 (1- (quasar.protocol:json-value state "documentSum")))
     (max 0 (1- (quasar.protocol:json-value state "graphSum")))))

(defun %write-materialized-quota (store workspace)
  ;; Only explicit full replacement/compatibility callers supply a complete
  ;; workspace. Use it directly; don't scan canonical state again.
  (%put-record (tek9-store-database store)
               (%workspace-meta-key (quasar.workspace:workspace-id workspace))
               (%workspace-meta-with-document-count workspace))
  (%delete-prefix-bounded (tek9-store-database store)
                          (format nil "quasar/v1/quota-graph/~A/"
                                  (%key-part (quasar.workspace:workspace-id workspace))))
  (let ((document-sum 0) (graph-sum 0)
        (id (quasar.workspace:workspace-id workspace)))
    (maphash (lambda (key document) (declare (ignore key))
               (incf document-sum (1+ (%json-octet-count document))))
             (quasar.workspace:workspace-documents workspace))
    (maphash (lambda (graph-id graph)
               (incf graph-sum (1+ (%json-octet-count graph)))
               (%put-record (tek9-store-database store) (%quota-graph-key id graph-id)
                            (%quota-graph-from-json graph)))
             (quasar.workspace:workspace-graphs workspace))
    (%put-record (tek9-store-database store) (%quota-key id)
     (quasar.protocol:json-object
      (cons "version" +quota-version+) (cons "revision" (quasar.workspace:workspace-revision workspace))
      (cons "documentSum" document-sum) (cons "graphSum" graph-sum)))))

(defmethod save-workspace :after ((store tek9-store) workspace)
  ;; Existing SAVE-WORKSPACE :AROUND keeps this within its write transaction.
  (%write-materialized-quota store workspace))

(defmethod commit-workspace :around ((store tek9-store) workspace operation)
  ;; Preserve explicit compatibility callers without allowing stale counters.
  (tek9:with-write-transaction ((tek9-store-database store))
    (prog1 (call-next-method) (%write-materialized-quota store workspace))))
