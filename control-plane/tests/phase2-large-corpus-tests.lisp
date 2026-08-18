(in-package #:quasar.tests)

(defun phase2-large-corpus-id (index)
  (format nil "large:~8,'0D" index))

(defun phase2-make-large-corpus-workspace (count)
  (let ((workspace (make-workspace :id "large-corpus")))
    (dotimes (index count)
      (let ((id (phase2-large-corpus-id index)))
        (setf
         (gethash id (workspace-documents workspace))
         (quasar.protocol:json-object
          (cons "_id" id)
          (cons "dtype" "person")
          (cons "ordinal" index)
          (cons "text" (format nil "fixture-~8,'0D-λ-雪" index))))))
    workspace))

(defun test-phase2-ten-thousand-document-direct-reads ()
  (let* ((count 10000)
         (path (unique-tek9-test-path "phase2-10k-read"))
         (store-1 nil)
         (store-2 nil)
         (plane nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path))
           (quasar.store:save-workspace
            store-1
            (phase2-make-large-corpus-workspace count))
           (quasar.store:close-store store-1)
           (setf store-1 nil
                 store-2 (quasar.store:make-tek9-store :path path)
                 plane
                 (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store-2)))
           (check
            (= 0
               (hash-table-count
                (quasar.control-plane:control-plane-workspaces plane))))
           (let* ((target (phase2-large-corpus-id (1- count)))
                  (response
                    (call-command
                     plane
                     (make-envelope
                      "document.get"
                      (quasar.protocol:json-object (cons "id" target))
                      :workspace "large-corpus"
                      :id "large-direct-get"))))
             (check (string= "ok" (status response)))
             (check
              (string=
               target
               (quasar.protocol:json-value (result response) "_id"))))
           (check
            (= 0
               (hash-table-count
                (quasar.control-plane:control-plane-workspaces plane))))
           (let* ((response
                    (call-command
                     plane
                     (make-envelope
                      "workspace.snapshot"
                      (quasar.protocol:json-object
                       (cons "documentOffset" 0)
                       (cons "documentByteLimit" 4096))
                      :workspace "large-corpus"
                      :id "large-first-page")))
                  (snapshot (result response))
                  (documents
                    (array-elements-for-test
                     (quasar.protocol:json-value snapshot "documents")))
                  (page
                    (quasar.protocol:json-value
                     snapshot "documentPage")))
             (check (string= "ok" (status response)))
             (check (plusp (length documents)))
             (check (< (length documents) count))
             (check (= count (quasar.protocol:json-value page "total")))
             (check
              (= (length documents)
                 (quasar.protocol:json-value page "nextOffset")))
             (check
              (not
               (eq t
                   (quasar.protocol:json-value page "complete")))))
           (check
            (= 0
               (hash-table-count
                (quasar.control-plane:control-plane-workspaces plane))))
           (format
            t
            "~&Phase2 large-corpus evidence: ~D canonical documents, direct get + 4096-byte page retained zero cached workspaces.~%"
            count))
      (when plane
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-ten-thousand-document-pagination ()
  (let* ((count 10000)
         (path (unique-tek9-test-path "phase2-10k-page"))
         (store-1 nil)
         (store-2 nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path))
           (quasar.store:save-workspace
            store-1
            (phase2-make-large-corpus-workspace count))
           (quasar.store:close-store store-1)
           (setf store-1 nil
                 store-2 (quasar.store:make-tek9-store :path path))
           (let ((offset 0)
                 (seen 0)
                 (last-id nil)
                 (pages 0)
                 (done nil))
             (loop
               until done
               do
                 (let* ((snapshot
                          (quasar.store:direct-workspace-snapshot-page
                           store-2 "large-corpus" offset (* 64 1024)))
                        (documents
                          (array-elements-for-test
                           (quasar.protocol:json-value
                            snapshot "documents")))
                        (page
                          (quasar.protocol:json-value
                           snapshot "documentPage"))
                        (next
                          (quasar.protocol:json-value
                           page "nextOffset")))
                   (check (plusp (length documents)))
                   (dolist (document documents)
                     (let ((id
                             (quasar.protocol:json-value
                              document "_id")))
                       (when last-id
                         (check (string< last-id id)))
                       (setf last-id id)
                       (incf seen)))
                   (incf pages)
                   (check (> next offset))
                   (setf offset next
                         done
                         (eq t
                             (quasar.protocol:json-value
                              page "complete")))))
             (check (= count seen))
             (check (= count offset))
             (check (> pages 1))
             (check
              (string=
               (phase2-large-corpus-id (1- count))
               last-id))
             (format
              t
              "~&Phase2 pagination evidence: ~D documents traversed exactly once across ~D bounded pages.~%"
              seen pages)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun run-phase2-large-corpus-tests ()
  (let ((*failures* 0))
    (test-phase2-ten-thousand-document-direct-reads)
    (test-phase2-ten-thousand-document-pagination)
    (when (plusp *failures*)
      (error "~D Phase 2 large-corpus tests failed." *failures*))
    t))