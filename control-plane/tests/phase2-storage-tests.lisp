(in-package #:quasar.tests)

(defun phase2-session-id (response)
  (quasar.protocol:json-value (result response) "sessionId"))

(defun phase2-import-chunk-payload (session-id sequence &rest documents)
  (quasar.protocol:json-object
   (cons "sessionId" session-id)
   (cons "sequence" sequence)
   (cons "operations"
         (apply #'quasar.protocol:json-array
                (loop for document in documents
                      collect (quasar.protocol:json-object
                               (cons "type" "document.create")
                               (cons "payload" document)))))))

(defun phase2-import-update-chunk-payload (session-id sequence document)
  (quasar.protocol:json-object
   (cons "sessionId" session-id)
   (cons "sequence" sequence)
   (cons "operations"
         (quasar.protocol:json-array
          (quasar.protocol:json-object
           (cons "type" "document.update")
           (cons "payload" document))))))

(defun phase2-begin-import (plane &key (workspace "default") (id "phase2-begin"))
  (call-command
   plane
   (make-envelope "document.import.begin"
                  (quasar.protocol:empty-object)
                  :workspace workspace
                  :id id)))

(defun phase2-send-chunk (plane payload &key (workspace "default") (id "phase2-chunk"))
  (call-command
   plane
   (make-envelope "document.import.chunk" payload
                  :workspace workspace
                  :id id)))

(defun phase2-commit-import (plane session-id &key (workspace "default") (id "phase2-commit"))
  (call-command
   plane
   (make-envelope "document.import.commit"
                  (quasar.protocol:json-object (cons "sessionId" session-id))
                  :workspace workspace
                  :id id)))

(defun phase2-abort-import (plane session-id &key (workspace "default") (id "phase2-abort"))
  (call-command
   plane
   (make-envelope "document.import.abort"
                  (quasar.protocol:json-object (cons "sessionId" session-id))
                  :workspace workspace
                  :id id)))

(defun phase2-control-plane-import-session-count (plane)
  (let ((accessor (find-symbol "CONTROL-PLANE-IMPORT-SESSIONS"
                               "QUASAR.CONTROL-PLANE")))
    (if (and accessor (fboundp accessor))
        (hash-table-count (funcall accessor plane))
        0)))

(defun phase2-create-documents (plane count &key (workspace "default") (prefix "seed"))
  (dotimes (index count)
    (let ((id (format nil "~A:~8,'0D" prefix index)))
      (check
       (tek9-command-ok-p
        plane "document.create"
        (quasar.protocol:json-object
         (cons "_id" id)
         (cons "dtype" "person")
         (cons "ordinal" index))
        :workspace workspace
        :id (format nil "create-~D" index))))))

(defun phase2-reopen-plane (path)
  (let ((store (quasar.store:make-tek9-store :path path)))
    (values store
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store)))))

(defun test-phase2-document-get-does-not-materialize-corpus ()
  (let* ((path (unique-tek9-test-path "phase2-direct-get"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (phase2-create-documents plane-1 128)
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-reopen-plane path))
           (check (= 0 (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-2))))
           (let ((response
                   (call-command
                    plane-2
                    (make-envelope
                     "document.get"
                     (quasar.protocol:json-object (cons "id" "seed:00000127"))
                     :id "phase2-direct-get"))))
             (check (string= "ok" (status response)))
             (check (string= "seed:00000127"
                             (quasar.protocol:json-value (result response) "_id"))))
           ;; Direct reads must not populate the full-workspace compatibility cache.
           (check (= 0 (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-2)))))
      (when plane-1
        (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-paged-snapshot-does-not-materialize-corpus ()
  (let* ((path (unique-tek9-test-path "phase2-direct-page"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (phase2-create-documents plane-1 256)
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-reopen-plane path))
           (let* ((response
                    (call-command
                     plane-2
                     (make-envelope
                      "workspace.snapshot"
                      (quasar.protocol:json-object
                       (cons "documentOffset" 0)
                       (cons "documentByteLimit" 1024))
                      :id "phase2-direct-page")))
                  (snapshot (result response))
                  (documents (quasar.protocol:json-value snapshot "documents")))
             (check (string= "ok" (status response)))
             (check (plusp (length (array-elements-for-test documents))))
             (check (< (length (array-elements-for-test documents)) 256)))
           (check (= 0 (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-2)))))
      (when plane-1
        (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-stage-is-durable-not-process-local ()
  (with-temporary-tek9-store (store path "phase2-stage-local")
    (declare (ignore path))
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-begin-import plane))
                  (session-id (phase2-session-id begin)))
             (check (string= "ok" (status begin)))
             (check session-id)
             ;; Stage authority belongs to Tek9. The control plane must not retain
             ;; candidate workspaces or chunk history in its session hash.
             (check (= 0 (phase2-control-plane-import-session-count plane))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-import-survives-process-restart ()
  (let* ((path (unique-tek9-test-path "phase2-import-restart"))
         (store-1 nil)
         (store-2 nil)
         (store-3 nil)
         (plane-1 nil)
         (plane-2 nil)
         (plane-3 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (check (tek9-command-ok-p plane-1 "document.create" (make-doc "base")))
           (let ((begin (phase2-begin-import plane-1)))
             (check (string= "ok" (status begin)))
             (setf session-id (phase2-session-id begin)))
           (let ((chunk
                   (phase2-send-chunk
                    plane-1
                    (phase2-import-chunk-payload
                     session-id 0
                     (make-doc "imported:1")
                     (make-doc "imported:2")))))
             (check (string= "ok" (status chunk))))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-reopen-plane path))
           (let ((commit (phase2-commit-import plane-2 session-id)))
             (check (string= "ok" (status commit)))
             (check (= 2 (quasar.protocol:json-value (result commit) "documentCount"))))
           (quasar.control-plane:stop-control-plane plane-2)
           (setf plane-2 nil)
           (quasar.store:close-store store-2)
           (setf store-2 nil)
           (multiple-value-setq (store-3 plane-3) (phase2-reopen-plane path))
           (dolist (id '("imported:1" "imported:2"))
             (let ((response
                     (call-command
                      plane-3
                      (make-envelope "document.get"
                                     (quasar.protocol:json-object (cons "id" id))
                                     :id (format nil "get-~A" id)))))
               (check (string= "ok" (status response)))
               (check (string= id
                               (quasar.protocol:json-value (result response) "_id"))))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when plane-3 (ignore-errors (quasar.control-plane:stop-control-plane plane-3)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when store-3 (ignore-errors (quasar.store:close-store store-3)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-chunk-replay-is-idempotent ()
  (with-temporary-tek9-store (store path "phase2-replay")
    (declare (ignore path))
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-begin-import plane))
                  (session-id (phase2-session-id begin))
                  (payload (phase2-import-chunk-payload
                            session-id 0 (make-doc "replay:1")))
                  (first (phase2-send-chunk plane payload :id "chunk-first"))
                  (second (phase2-send-chunk plane payload :id "chunk-replay")))
             (check (string= "ok" (status first)))
             (check (string= "ok" (status second)))
             (check (= 1 (quasar.protocol:json-value (result first) "documentCount")))
             (check (= 1 (quasar.protocol:json-value (result second) "documentCount")))
             (let ((commit (phase2-commit-import plane session-id)))
               (check (string= "ok" (status commit)))
               (check (= 1 (quasar.protocol:json-value (result commit) "documentCount")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-conflicting-replay-and-sequence-gap-are-stable ()
  (with-temporary-tek9-store (store path "phase2-sequence")
    (declare (ignore path))
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-begin-import plane))
                  (session-id (phase2-session-id begin))
                  (first (phase2-send-chunk
                          plane
                          (phase2-import-chunk-payload
                           session-id 0 (make-doc "seq:1")))))
             (check (string= "ok" (status first)))
             (let ((conflict
                     (phase2-send-chunk
                      plane
                      (phase2-import-chunk-payload
                       session-id 0 (make-doc "seq:different"))
                      :id "sequence-conflict")))
               (check (string= "error" (status conflict)))
               (check (string= "import.chunk-conflict" (error-code conflict))))
             (let ((gap
                     (phase2-send-chunk
                      plane
                      (phase2-import-chunk-payload
                       session-id 2 (make-doc "seq:gap"))
                      :id "sequence-gap")))
               (check (string= "error" (status gap)))
               (check (string= "import.sequence-gap" (error-code gap)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-revision-conflict-after-restart-is-atomic ()
  (let* ((path (unique-tek9-test-path "phase2-revision-conflict"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (check (tek9-command-ok-p plane-1 "document.create" (make-doc "base")))
           (let ((begin (phase2-begin-import plane-1)))
             (setf session-id (phase2-session-id begin)))
           (check
            (string= "ok"
                     (status
                      (phase2-send-chunk
                       plane-1
                       (phase2-import-chunk-payload
                        session-id 0 (make-doc "must-not-commit"))))))
           (check (tek9-command-ok-p plane-1 "document.create" (make-doc "concurrent")))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-reopen-plane path))
           (let ((commit (phase2-commit-import plane-2 session-id)))
             (check (string= "error" (status commit)))
             (check (string= "workspace.revision-conflict" (error-code commit))))
           (let ((missing
                   (call-command
                    plane-2
                    (make-envelope "document.get"
                                   (quasar.protocol:json-object
                                    (cons "id" "must-not-commit"))
                                   :id "must-not-exist"))))
             (check (string= "document.not-found" (error-code missing))))
           (let ((present
                   (call-command
                    plane-2
                    (make-envelope "document.get"
                                   (quasar.protocol:json-object
                                    (cons "id" "concurrent"))
                                   :id "concurrent-still-there"))))
             (check (string= "ok" (status present)))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-abort-survives-restart-and-is-idempotent ()
  (let* ((path (unique-tek9-test-path "phase2-abort"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (let ((begin (phase2-begin-import plane-1)))
             (setf session-id (phase2-session-id begin)))
           (check
            (string= "ok"
                     (status
                      (phase2-send-chunk
                       plane-1
                       (phase2-import-chunk-payload
                        session-id 0 (make-doc "abort:1"))))))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-reopen-plane path))
           (check (string= "ok" (status (phase2-abort-import plane-2 session-id))))
           (check (string= "ok"
                           (status (phase2-abort-import
                                    plane-2 session-id :id "abort-again"))))
           (let ((commit (phase2-commit-import plane-2 session-id)))
             (check (string= "error" (status commit)))
             (check (string= "import.invalid-session" (error-code commit)))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-import-journal-is-compact ()
  (with-temporary-tek9-store (store path "phase2-journal")
    (declare (ignore path))
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-begin-import plane))
                  (session-id (phase2-session-id begin)))
             (check
              (string= "ok"
                       (status
                        (phase2-send-chunk
                         plane
                         (phase2-import-chunk-payload
                          session-id 0
                          (make-doc "journal:1")
                          (make-doc "journal:2"))))))
             (check (string= "ok" (status (phase2-commit-import plane session-id))))
             (let* ((entries (quasar.store:store-journal-entries store "default"))
                    (entry (car (last entries))))
               (check entry)
               (check (string= "document.import"
                               (quasar.protocol:json-value entry "command")))
               (check (= 2 (quasar.protocol:json-value entry "documentCount")))
               (check (null (quasar.protocol:json-value entry "encodedChunks")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-phase2-storage-tests ()
  (let ((*failures* 0))
    (test-phase2-document-get-does-not-materialize-corpus)
    (test-phase2-paged-snapshot-does-not-materialize-corpus)
    (test-phase2-stage-is-durable-not-process-local)
    (test-phase2-import-survives-process-restart)
    (test-phase2-chunk-replay-is-idempotent)
    (test-phase2-conflicting-replay-and-sequence-gap-are-stable)
    (test-phase2-revision-conflict-after-restart-is-atomic)
    (test-phase2-abort-survives-restart-and-is-idempotent)
    (test-phase2-import-journal-is-compact)
    (when (plusp *failures*)
      (error "~D Phase 2 storage tests failed." *failures*))
    t))