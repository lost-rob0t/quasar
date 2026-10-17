(in-package #:quasar.store)

;; Versioned derived records. Canonical v1 records remain authoritative. All
;; maintenance functions below run inside their caller's Tek9 write transaction.
(defparameter +graph-index-version+ 1)
(defparameter +graph-catalog-row-bytes+ 8192)

(dolist (code '("graph.catalog-migration-required" "graph.catalog-invalid"))
  (pushnew code quasar.protocol::+error-codes+ :test #'string=))

(defun %graph-catalog-prefix (workspace-id)
  (concatenate 'string (%workspace-prefix workspace-id) "graph-catalog-v1/"))

(defun %graph-catalog-key (workspace-id graph-id)
  (concatenate 'string (%graph-catalog-prefix workspace-id) (%key-part graph-id)))

(defun %graph-index-prefix (workspace-id graph-id &optional section)
  (format nil "~Agraph-index-v1/~A/~A" (%workspace-prefix workspace-id)
          (%key-part graph-id) (if section (concatenate 'string section "/") "")))

(defun %graph-catalog-ready-key (workspace-id)
  (concatenate 'string (%workspace-prefix workspace-id) "graph-catalog-version"))

(defun %mark-graph-catalog-ready (database workspace-id)
  (%put-record database (%graph-catalog-ready-key workspace-id)
               (quasar.protocol:json-object (cons "version" +graph-index-version+))))

(defun %graph-catalog-ready-p (database workspace-id)
  (eql +graph-index-version+
       (quasar.protocol:json-value
        (tek9:fetch* database (%graph-catalog-ready-key workspace-id)) "version")))

(defun %require-graph-catalog (database workspace-id)
  (unless (or (%graph-catalog-ready-p database workspace-id)
              ;; A workspace that has never been persisted has an empty catalog.
              ;; Reads must not create durable state or require a migration.
              (null (tek9:fetch* database (%workspace-meta-key workspace-id))))
    (%query-error "graph.catalog-migration-required"
                  "Run the explicit graph catalog migration before bounded graph reads.")))

(defun %put-compact-graph-record (database key value)
  (when (> (%utf8-length (quasar.protocol:encode value)) +graph-catalog-row-bytes+)
    (%query-error "graph.catalog-invalid" "Graph catalog/index row exceeds 8192 UTF-8 bytes."))
  (%put-record database key value))

(defun %graph-collection-kind (value)
  (cond ((quasar.protocol:object-p value) "object")
        ((eq :null value) "null")
        ((quasar.protocol:array-p value) "array")
        (t (%query-error "graph.catalog-invalid" "Invalid graph collection."))))

(defun %index-graph-collection (database workspace-id graph-id section value)
  (let ((prefix (%graph-index-prefix workspace-id graph-id section))
        (kind (%graph-collection-kind value)))
    (%delete-prefix-bounded database prefix)
    (cond
      ((string= kind "object")
       (loop for (key . item) in (rest value)
             do (%put-compact-graph-record
                 database (concatenate 'string prefix (%key-part key))
                 (quasar.protocol:json-object (cons "key" key) (cons "value" item)))))
      ((string= kind "array")
       (loop for item in (quasar.workspace:array-elements value) for index from 0
             do (%put-compact-graph-record
                 database (format nil "~A~20,'0D" prefix index)
                 (if (string= section "members")
                     (quasar.protocol:json-object (cons "documentId" item))
                     (quasar.protocol:json-object (cons "index" index) (cons "value" item)))))))
    kind))

(defun %put-graph-metadata (database workspace-id graph-id graph)
  "Maintain compact metadata without scanning topology. Existing counts survive."
  (%query-string graph-id "graphId")
  (let* ((key (%graph-catalog-key workspace-id graph-id))
         (old (tek9:fetch* database key))
         (members (quasar.protocol:json-value graph "documentIds" :null))
         (mode (if (eq :null members) "all" "explicit"))
         (kinds (quasar.protocol:empty-object)))
    (unless (or (string= mode "all")
                (quasar.protocol:array-p members))
      (%query-error "graph.catalog-invalid" "Graph membership must be an array or null."))
    (dolist (pair '(("documentIds" . "members") ("positions" . "positions")
                    ("groups" . "groups") ("selectedIds" . "selection")))
      (quasar.protocol:object-set
       kinds (car pair)
       (%index-graph-collection database workspace-id graph-id (cdr pair)
                                (quasar.protocol:json-value graph (car pair) :null))))
    (%put-compact-graph-record
     database (concatenate 'string (%graph-index-prefix workspace-id graph-id "descriptor") "0")
     (quasar.protocol:json-object
      (cons "metadata"
            (cons :obj (loop for (field . value) in (rest graph)
                             unless (member field '("nodes" "edges" "documentIds" "positions" "groups" "selectedIds")
                                            :test #'string=)
                               collect (cons field value))))
      (cons "collectionKinds" kinds)))
    (%put-compact-graph-record
     database key
     (quasar.protocol:json-object
      (cons "id" graph-id) (cons "name" (quasar.protocol:json-value graph "name" graph-id))
      (cons "membershipMode" mode)
      (cons "documentCount" (if (string= mode "all") :null (length (quasar.workspace:array-elements members))))
      (cons "nodeCount" (quasar.protocol:json-value old "nodeCount" 0))
      (cons "edgeCount" (quasar.protocol:json-value old "edgeCount" 0))))
    (%put-record database (%graph-meta-key workspace-id graph-id) (%graph-metadata graph))))

(defun %graph-count-delta (database workspace-id graph-id field delta)
  (unless (zerop delta)
    (let* ((key (%graph-catalog-key workspace-id graph-id))
           (row (tek9:fetch* database key)))
      ;; Legacy workspaces remain explicitly unavailable until migration; never
      ;; scan legacy metadata or topology on an ordinary delta to invent counts.
      (when row
        (quasar.protocol:object-set row field
                                   (+ delta (quasar.protocol:json-value row field 0)))
        (%put-compact-graph-record database key row)))))

(defun %delete-graph-index (database workspace-id graph-id)
  (tek9:delete-document database (%graph-catalog-key workspace-id graph-id))
  (%delete-prefix-bounded database (%graph-index-prefix workspace-id graph-id)))

(defun migrate-graph-catalog (store workspace-id &key expected-revision)
  "Explicit operator migration, NOT a startup/read endpoint. Atomic full rebuild.
Legacy metadata may be large. Read sidecars in bounded batches, never restore
whole topology. A failed transaction leaves the prior generation unchanged."
  (let ((database (tek9-store-database store)) (graphs 0))
    (tek9:with-write-transaction (database)
      (let ((revision (quasar.protocol:json-value (%read-meta database workspace-id) "revision" 0)))
        (when (and expected-revision (/= expected-revision revision))
          (%query-error "query.stale-cursor" "Workspace changed before migration."))
        (%delete-prefix-bounded database (%graph-catalog-prefix workspace-id))
        (%delete-prefix-bounded database
                                (concatenate 'string (%workspace-prefix workspace-id) "graph-index-v1/"))
        (let ((prefix (%graph-meta-prefix workspace-id)) (start nil))
          (loop for row = (first (%bounded-range database prefix :start start :limit 1))
                while row
                do (let* ((graph (cdr row)) (id (quasar.protocol:json-value graph "id")))
                     (%put-graph-metadata database workspace-id id graph)
                     (dolist (pair (list (cons "nodeCount" (%node-prefix workspace-id id))
                                        (cons "edgeCount" (%edge-prefix workspace-id id))))
                       (let ((count 0) (after nil))
                         (loop for rows = (%bounded-range database (cdr pair) :start after)
                               while rows do (incf count (length rows))
                                 (setf after (caar (last rows))))
                         (%graph-count-delta database workspace-id id (car pair) count)))
                     (incf graphs))
                   (setf start (car row))))
        ;; A never-persisted workspace has no graph catalog yet. Explicitly
        ;; initialize its default metadata using the same compatibility helper.
        (when (zerop graphs)
          (%ensure-default-graph-metadata database workspace-id)
          (setf graphs 1))
        (let ((hook (tek9-store-failure-hook store)))
          (when hook (funcall hook :before-graph-catalog-ready)))
        (%mark-graph-catalog-ready database workspace-id)
        (quasar.protocol:json-object (cons "version" +graph-index-version+)
                                     (cons "revision" revision) (cons "graphCount" graphs))))))

(defgeneric graph-catalog-page (store workspace-id request))
(defgeneric graph-content-page (store workspace-id request))

(defmethod graph-catalog-page ((store workspace-store) workspace-id request)
  (declare (ignore workspace-id request))
  (%query-error "query.unsupported-store" "Bounded graph reads require Tek9."))

(defmethod graph-content-page ((store workspace-store) workspace-id request)
  (declare (ignore workspace-id request))
  (%query-error "query.unsupported-store" "Bounded graph reads require Tek9."))

(defun %bounded-graph-page (database workspace-id request revision scope prefix projection extras &optional project)
  "One seek per row; retain one bounded page and Tek9's exclusive lookahead."
  (let* ((limit (%query-integer request "limit" 50 1 *query-max-records*))
         (byte-limit (%query-integer request "byteLimit" *query-max-bytes* 32768 *query-max-bytes*))
         (scan-limit (%query-integer request "scanLimit" *query-max-scanned* 1 *query-max-scanned*))
         (milliseconds (%query-integer request "deadlineMs" *query-max-milliseconds* 1 *query-max-milliseconds*))
         (began (funcall *query-clock*))
         (start (or (%cursor-start request workspace-id revision scope prefix) prefix))
         (rows nil) (count 0) (bytes 0) (scanned 0) (complete nil) (reason "records"))
    (unless (eql revision (quasar.protocol:json-value request "expectedRevision" revision))
      (%query-error "query.stale-cursor" "Workspace changed; restart graph loading."))
    (loop
      (when (>= count limit) (return))
      (when (>= scanned scan-limit) (setf reason "scan-budget") (return))
      (when (>= (* 1000 (- (funcall *query-clock*) began))
                (* milliseconds internal-time-units-per-second))
        (setf reason "deadline") (return))
      (let ((entry (first (%bounded-range database prefix :start start :limit 1))))
        (unless entry (setf complete t reason "complete") (return))
        (incf scanned)
        (let* ((value (if project (funcall project (cdr entry)) (cdr entry)))
               (size (%utf8-length (quasar.protocol:encode value))))
          (when (> (+ bytes size) (- byte-limit 16384))
            (unless rows (%query-error "query.record-too-large" "Graph record exceeds page byte budget."))
            (setf reason "bytes") (return))
          (push value rows) (incf bytes size) (incf count))
        (setf start (car entry))))
    (let ((result (apply #'quasar.protocol:json-object
                         (append
                          (list (cons "revision" revision) (cons "projection" projection)
                                (cons (cond ((string= projection "graph-catalog.v1") "graphs")
                                            ((member projection '("dataset-catalog.v1" "workspace-statistics-datasets.v1") :test #'equal) "datasets")
                                            (t "records"))
                                      (cons :array (nreverse rows)))
                                (cons "complete" (if complete t :false))
                                (cons "cursor" (if complete :null (%search-cursor workspace-id revision scope start)))
                                (cons "performance" (quasar.protocol:json-object
                                                     (cons "mode" "bounded-graph-seek")
                                                     (cons "scanned" scanned) (cons "stopReason" reason))))
                          extras))))
      (when (> (%utf8-length (quasar.protocol:encode result)) byte-limit)
        (%query-error "query.record-too-large" "Graph continuation exceeds page byte budget."))
      result)))

(defmethod graph-catalog-page ((store tek9-store) workspace-id request)
  (%query-keys request '("limit" "byteLimit" "scanLimit" "deadlineMs" "cursor" "expectedRevision"))
  (let ((database (tek9-store-database store)))
    (tek9:with-read-transaction (database)
      (%require-graph-catalog database workspace-id)
      (let* ((meta (%read-meta database workspace-id))
             (revision (quasar.protocol:json-value meta "revision" 0)))
        (%bounded-graph-page
         database workspace-id request revision (quasar.protocol:json-object (cons "kind" "graph-catalog.v1"))
         (%graph-catalog-prefix workspace-id) "graph-catalog.v1"
         (list (cons "savedGraphId" (quasar.protocol:json-value meta "activeGraphId" "all-documents")))
         (lambda (row)
           (when (equal "all" (quasar.protocol:json-value row "membershipMode"))
             (quasar.protocol:object-set row "documentCount" (quasar.protocol:json-value meta "documentCount" :null)))
           row))))))

(defmethod graph-content-page ((store tek9-store) workspace-id request)
  (%query-keys request '("graphId" "section" "limit" "byteLimit" "scanLimit" "deadlineMs" "cursor" "expectedRevision"))
  (let* ((id (%query-string (quasar.protocol:json-value request "graphId") "graphId"))
         (section (quasar.protocol:json-value request "section"))
         (database (tek9-store-database store)))
    (unless (member section '("members" "nodes" "edges" "positions" "groups" "selection" "descriptor") :test #'equal)
      (%query-error "query.invalid" "Unknown graph section."))
    (tek9:with-read-transaction (database)
      (%require-graph-catalog database workspace-id)
      (let* ((catalog (tek9:fetch* database (%graph-catalog-key workspace-id id)))
             (meta (%read-meta database workspace-id))
             (all (and (equal section "members") (equal "all" (quasar.protocol:json-value catalog "membershipMode")))))
        (unless catalog (%query-error "graph.not-found" "Graph does not exist."))
        (%bounded-graph-page
         database workspace-id request (quasar.protocol:json-value meta "revision" 0)
         (quasar.protocol:json-object (cons "kind" "graph-page.v1") (cons "graphId" id) (cons "section" section))
         (cond (all (%document-prefix workspace-id))
               ((equal section "nodes") (%node-prefix workspace-id id))
               ((equal section "edges") (%edge-prefix workspace-id id))
               (t (%graph-index-prefix workspace-id id section)))
         "graph-page.v1" (list (cons "graphId" id) (cons "section" section))
         (when all (lambda (document)
                     (quasar.protocol:json-object (cons "documentId" (quasar.protocol:starintel-document-id document))))))))))
