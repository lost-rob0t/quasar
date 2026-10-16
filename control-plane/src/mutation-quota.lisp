(in-package #:quasar.store)

(defun %json-octet-count (value)
  (length (babel:string-to-octets (quasar.protocol:encode value) :encoding :utf-8)))

(defun %quota-key (workspace-id)
  (format nil "quasar/v1/quota/~A" (%key-part workspace-id)))

(defun %quota-array-contribution (database prefix)
  "Bytes added to an empty JSON array, with only a range batch retained."
  (let ((sum 0) (count 0))
    (%map-prefix-bounded
     database prefix
     (lambda (row)
       (incf sum (1+ (%json-octet-count (cdr row))))
       (incf count)))
    (values (max 0 (1- sum)) count)))

(defun %quota-graph-size (database workspace-id graph-id)
  (let ((metadata (tek9:fetch* database (%graph-meta-key workspace-id graph-id))))
    (when metadata
      (+ (%json-octet-count (%graph-with-empty-topology metadata))
         (%quota-array-contribution database (%node-prefix workspace-id graph-id))
         (%quota-array-contribution database (%edge-prefix workspace-id graph-id))))))

(defun %quota-baseline (database workspace-id revision)
  "Upgrade legacy accounting in bounded batches; never restore a workspace.
This one-time scan is also needed after a legacy writer/import changes revision.
It has bounded retained memory, but its total work is corpus-sized."
  (multiple-value-bind (document-bytes document-count)
      (%quota-array-contribution database (%document-prefix workspace-id))
    (let ((graph-sum 0) (graph-count 0))
      (%map-prefix-bounded
       database (%graph-meta-prefix workspace-id)
       (lambda (row)
         (incf graph-sum
               (1+ (%quota-graph-size database workspace-id
                                     (quasar.protocol:json-value (cdr row) "id"))))
         (incf graph-count)))
      (quasar.protocol:json-object
       (cons "version" 1) (cons "revision" revision)
       (cons "documentSum" (+ document-bytes (if (plusp document-count) 1 0)))
       (cons "graphSum" graph-sum)))))

(defun %quota-state (database workspace-id revision)
  (let ((state (tek9:fetch* database (%quota-key workspace-id))))
    (if (and state (eql 1 (quasar.protocol:json-value state "version"))
             (eql revision (quasar.protocol:json-value state "revision")))
        (quasar.protocol:clone-json state)
        (%quota-baseline database workspace-id revision))))

(defun %quota-document-delta (database workspace-id change)
  (when (member (quasar.workspace:persistence-change-kind change)
                '(:document-upsert :document-delete))
    (let* ((previous (tek9:fetch* database (%document-key workspace-id
                                    (quasar.workspace:persistence-change-id change))))
           (next (and (eq :document-upsert (quasar.workspace:persistence-change-kind change))
                      (quasar.workspace:persistence-change-value change))))
      (- (if next (1+ (%json-octet-count next)) 0)
         (if previous (1+ (%json-octet-count previous)) 0)))))

(defun %quota-snapshot-size (workspace-id revision settings state)
  (+ (%json-octet-count
      (quasar.protocol:json-object
       (cons "id" workspace-id) (cons "revision" revision)
       (cons "documents" (quasar.protocol:json-array))
       (cons "graphs" (quasar.protocol:json-array))
       (cons "activeGraphId" (or (quasar.protocol:json-value settings "activeGraphId")
                                 "all-documents"))
       (cons "settings" settings)))
     (max 0 (1- (quasar.protocol:json-value state "documentSum")))
     (max 0 (1- (quasar.protocol:json-value state "graphSum")))))

(defmethod save-workspace :after ((store tek9-store) workspace)
  ;; The existing SAVE-WORKSPACE :AROUND method keeps this in the same Tek9
  ;; transaction as explicit bootstrap/replacement, including equal revisions.
  (%put-record (tek9-store-database store)
               (%workspace-meta-key (quasar.workspace:workspace-id workspace))
               (%workspace-meta-with-document-count workspace))
  (let ((document-sum 0) (graph-sum 0))
    (maphash (lambda (id document) (declare (ignore id))
               (incf document-sum (1+ (%json-octet-count document))))
             (quasar.workspace:workspace-documents workspace))
    (maphash (lambda (id graph) (declare (ignore id))
               (incf graph-sum (1+ (%json-octet-count graph))))
             (quasar.workspace:workspace-graphs workspace))
    (%put-record
     (tek9-store-database store) (%quota-key (quasar.workspace:workspace-id workspace))
     (quasar.protocol:json-object
      (cons "version" 1)
      (cons "revision" (quasar.workspace:workspace-revision workspace))
      (cons "documentSum" document-sum) (cons "graphSum" graph-sum)))))
