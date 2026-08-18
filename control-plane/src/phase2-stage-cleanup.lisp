(in-package #:quasar.store)

(defmethod abort-import-stage
    ((store tek9-store) workspace-id stage-id now)
  (declare (ignore now))
  (let ((database (tek9-store-database store)))
    (tek9:with-write-transaction (database)
      (let ((meta
              (tek9:fetch*
               database (%stage-meta-key workspace-id stage-id))))
        (when
            (and
             meta
             (string=
              "COMMITTED"
              (or
               (quasar.protocol:json-value meta "state")
               "")))
          (%stage-error
           "import.invalid-session"
           "A committed import cannot be aborted."))
        (%delete-prefix-bounded
         database
         (%stage-document-prefix workspace-id stage-id))
        (%delete-prefix-bounded
         database
         (%stage-chunk-prefix workspace-id stage-id))
        (%clear-active-stage-if
         database workspace-id stage-id)
        (when meta
          (tek9:delete-document
           database (%stage-meta-key workspace-id stage-id)))))
    (quasar.protocol:json-object
     (cons "sessionId" stage-id)
     (cons "aborted" t))))

(defun %stage-expired-p (meta now ttl-seconds)
  (> (- now
        (or
         (quasar.protocol:json-value
          meta "lastActivityAt")
         now))
     ttl-seconds))

(defmethod cleanup-expired-import-stages
    ((store tek9-store) now
     &key (ttl-seconds +import-stage-ttl-seconds+))
  (let ((database (tek9-store-database store))
        (expired 0)
        (start nil))
    (loop
      for rows =
        (%bounded-range
         database (%active-stage-prefix) :start start)
      while rows
      do
        (dolist (row rows)
          (let* ((pointer (cdr row))
                 (workspace-id
                   (quasar.protocol:json-value
                    pointer "workspaceId"))
                 (stage-id
                   (quasar.protocol:json-value
                    pointer "sessionId"))
                 (meta
                   (and
                    workspace-id
                    stage-id
                    (tek9:fetch*
                     database
                     (%stage-meta-key
                      workspace-id stage-id)))))
            (when
                (and
                 meta
                 (string=
                  "OPEN"
                  (or
                   (quasar.protocol:json-value
                    meta "state")
                   ""))
                 (%stage-expired-p
                  meta now ttl-seconds))
              (abort-import-stage
               store workspace-id stage-id now)
              (incf expired))))
        (setf start (caar (last rows)))
      while (= (length rows) +phase2-range-batch-size+))
    expired))