(in-package #:quasar.store)

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
                           (setf more t
                                 done t)
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