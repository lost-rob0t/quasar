(in-package #:quasar.store)

(defun %promotion-outcome (store workspace-id stage-id operation-id client now)
  (let ((database (tek9-store-database store)))
    (tek9:with-write-transaction (database)
      (let* ((meta (%stage-meta-required database workspace-id stage-id))
             (state (or (quasar.protocol:json-value meta "state") "")))
        (cond
          ((string= state "COMMITTED")
           (list
            :ok
            (quasar.protocol:json-value meta "committedRevision")
            (quasar.protocol:json-value meta "documentCount" 0)
            (or (quasar.protocol:json-value meta "operationId")
                operation-id)))
          ((not (string= state "OPEN"))
           (%stage-error
            "import.invalid-session"
            "The document import session is not open."))
          (t
           (let* ((base-revision
                    (quasar.protocol:json-value meta "baseRevision"))
                  (canonical-meta
                    (tek9:fetch*
                     database
                     (%workspace-meta-key workspace-id)))
                  (current-revision
                    (or
                     (and canonical-meta
                          (quasar.protocol:json-value
                           canonical-meta
                           "revision"))
                     0)))
             (if (/= base-revision current-revision)
                 (progn
                   (quasar.protocol:object-set meta "state" "FAILED")
                   (quasar.protocol:object-set meta "lastActivityAt" now)
                   (quasar.protocol:object-set
                    meta
                    "errorCode"
                    "workspace.revision-conflict")
                   (%put-record
                    database
                    (%stage-meta-key workspace-id stage-id)
                    meta)
                   (%clear-active-stage-if database workspace-id stage-id)
                   (list :conflict current-revision base-revision))
                 (let* ((old-count
                          (%canonical-document-count
                           database
                           workspace-id
                           canonical-meta))
                        (document-count
                          (quasar.protocol:json-value
                           meta
                           "documentCount"
                           0))
                        (byte-count
                          (quasar.protocol:json-value
                           meta
                           "byteCount"
                           0))
                        (revision (1+ current-revision)))
                   (quasar.protocol:object-set
                    meta
                    "state"
                    "COMMITTING")
                   (%put-record
                    database
                    (%stage-meta-key workspace-id stage-id)
                    meta)
                   (let ((hook (tek9-store-failure-hook store)))
                     (when hook
                       (funcall hook :before-import-promotion)))
                   (let ((created
                           (%promote-stage-documents
                            database
                            workspace-id
                            stage-id)))
                     (let ((hook (tek9-store-failure-hook store)))
                       (when hook
                         (funcall hook :before-import-revision)))
                     (let ((next-meta
                             (or
                              (and
                               canonical-meta
                               (quasar.protocol:clone-json
                                canonical-meta))
                              (%default-workspace-meta
                               workspace-id
                               0
                               old-count))))
                       (quasar.protocol:object-set
                        next-meta
                        "revision"
                        revision)
                       (quasar.protocol:object-set
                        next-meta
                        "documentCount"
                        (+ old-count created))
                       (%put-record
                        database
                        (%workspace-meta-key workspace-id)
                        next-meta))
                     (%ensure-default-graph-metadata database workspace-id)
                     (let ((journal
                             (%compact-import-journal
                              workspace-id
                              stage-id
                              operation-id
                              client
                              base-revision
                              revision
                              document-count
                              byte-count
                              now)))
                       (let ((hook (tek9-store-failure-hook store)))
                         (when hook
                           (funcall hook :before-import-journal)))
                       (%put-record
                        database
                        (%journal-key workspace-id journal)
                        journal))
                     (let ((hook (tek9-store-failure-hook store)))
                       (when hook
                         (funcall hook :before-import-finalize)))
                     (%delete-prefix-bounded
                      database
                      (%stage-document-prefix workspace-id stage-id))
                     (%delete-prefix-bounded
                      database
                      (%stage-chunk-prefix workspace-id stage-id))
                     (%clear-active-stage-if database workspace-id stage-id)
                     (quasar.protocol:object-set
                      meta
                      "state"
                      "COMMITTED")
                     (quasar.protocol:object-set
                      meta
                      "committedRevision"
                      revision)
                     (quasar.protocol:object-set
                      meta
                      "operationId"
                      operation-id)
                     (quasar.protocol:object-set
                      meta
                      "lastActivityAt"
                      now)
                     (%put-record
                      database
                      (%stage-meta-key workspace-id stage-id)
                      meta)
                     (list :ok revision document-count operation-id)))))))))))

(defmethod promote-import-stage
    ((store tek9-store) workspace-id stage-id operation-id client now)
  (let ((outcome
          (%promotion-outcome
           store
           workspace-id
           stage-id
           operation-id
           client
           now)))
    (ecase (first outcome)
      (:ok
       (destructuring-bind
           (status revision document-count committed-operation-id)
           outcome
         (declare (ignore status))
         (quasar.protocol:json-object
          (cons "sessionId" stage-id)
          (cons "workspaceId" workspace-id)
          (cons "revision" revision)
          (cons "documentCount" document-count)
          (cons "operationId" committed-operation-id))))
      (:conflict
       (destructuring-bind
           (status current expected)
           outcome
         (declare (ignore status))
         (%stage-error
          "workspace.revision-conflict"
          (format
           nil
           "Workspace ~A is at revision ~D, import expected ~D."
           workspace-id
           current
           expected)))))))