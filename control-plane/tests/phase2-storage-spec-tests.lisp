(in-package #:quasar.tests)

(defun phase2-spec-session-id (response)
  (quasar.protocol:json-value (result response) "sessionId"))

(defun phase2-spec-chunk (session-id sequence &rest documents)
  (quasar.protocol:json-object
   (cons "sessionId" session-id)
   (cons "sequence" sequence)
   (cons "operations"
         (apply #'quasar.protocol:json-array
                (loop for document in documents
                      collect (quasar.protocol:json-object
                               (cons "type" "document.create")
                               (cons "payload" document)))))))

(defun phase2-spec-begin (plane &key (workspace "default") (id "phase2-begin"))
  (call-command
   plane
   (make-envelope "document.import.begin"
                  (quasar.protocol:empty-object)
                  :workspace workspace
                  :id id)))

(defun phase2-spec-send-chunk (plane payload &key (workspace "default") (id "phase2-chunk"))
  (call-command
   plane
   (make-envelope "document.import.chunk" payload
                  :workspace workspace
                  :id id)))

(defun phase2-spec-commit (plane session-id &key (workspace "default") (id "phase2-commit"))
  (call-command
   plane
   (make-envelope "document.import.commit"
                  (quasar.protocol:json-object (cons "sessionId" session-id))
                  :workspace workspace
                  :id id)))

(defun phase2-spec-abort (plane session-id &key (workspace "default") (id "phase2-abort"))
  (call-command
   plane
   (make-envelope "document.import.abort"
                  (quasar.protocol:json-object (cons "sessionId" session-id))
                  :workspace workspace
                  :id id)))

(defun phase2-spec-seed (plane count)
  (dotimes (index count)
    (check
     (tek9-command-ok-p
      plane
      "document.create"
      (quasar.protocol:json-object
       (cons "_id" (format nil "seed:~8,'0D" index))
       (cons "dtype" "person")
       (cons "ordinal" index))
      :id (format nil "phase2-seed-~D" index)))))

(defun phase2-spec-reopen (path)
  (let ((store (quasar.store:make-tek9-store :path path)))
    (values store
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store)))))

(defun phase2-spec-local-session-count (plane)
  (let ((accessor (find-symbol "CONTROL-PLANE-IMPORT-SESSIONS"
                               "QUASAR.CONTROL-PLANE")))
    (if (and accessor (fboundp accessor))
        (hash-table-count (funcall accessor plane))
        0)))

(defun test-phase2-spec-direct-document-get ()
  (let* ((path (unique-tek9-test-path "phase2-red-get"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (phase2-spec-seed plane-1 64)
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-spec-reopen path))
           (check (= 0 (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-2))))
           (let ((response
                   (call-command
                    plane-2
                    (make-envelope
                     "document.get"
                     (quasar.protocol:json-object (cons "id" "seed:00000063"))
                     :id "phase2-red-get"))))
             (check (string= "ok" (status response)))
             (check (string= "seed:00000063"
                             (quasar.protocol:json-value (result response) "_id"))))
           (check (= 0 (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-2)))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-spec-paged-snapshot ()
  (let* ((path (unique-tek9-test-path "phase2-red-page"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (phase2-spec-seed plane-1 96)
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-spec-reopen path))
           (let* ((response
                    (call-command
                     plane-2
                     (make-envelope
                      "workspace.snapshot"
                      (quasar.protocol:json-object
                       (cons "documentOffset" 0)
                       (cons "documentByteLimit" 512))
                      :id "phase2-red-page")))
                  (snapshot (result response))
                  (documents (quasar.protocol:json-value snapshot "documents")))
             (check (string= "ok" (status response)))
             (check (plusp (length (array-elements-for-test documents))))
             (check (< (length (array-elements-for-test documents)) 96)))
           (check (= 0 (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-2)))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-spec-stage-is-not-process-local ()
  (with-temporary-tek9-store (store path "phase2-red-local")
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin)))
             (check path)
             (check (string= "ok" (status begin)))
             (check session-id)
             (check (= 0 (phase2-spec-local-session-count plane))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-spec-stage-survives-restart ()
  (let* ((path (unique-tek9-test-path "phase2-red-stage-restart"))
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
           (let ((begin (phase2-spec-begin plane-1)))
             (setf session-id (phase2-spec-session-id begin)))
           (check
            (string= "ok"
                     (status
                      (phase2-spec-send-chunk
                       plane-1
                       (phase2-spec-chunk session-id 0
                                          (make-doc "restart:1")
                                          (make-doc "restart:2"))))))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-spec-reopen path))
           (let ((commit (phase2-spec-commit plane-2 session-id)))
             (check (string= "ok" (status commit)))
             (check (= 2 (quasar.protocol:json-value (result commit) "documentCount")))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-spec-chunk-replay ()
  (with-temporary-tek9-store (store path "phase2-red-replay")
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin))
                  (payload (phase2-spec-chunk session-id 0 (make-doc "replay:1")))
                  (first (phase2-spec-send-chunk plane payload :id "replay-first"))
                  (second (phase2-spec-send-chunk plane payload :id "replay-second")))
             (check path)
             (check (string= "ok" (status first)))
             (check (string= "ok" (status second)))
             (check (= 1 (quasar.protocol:json-value (result first) "documentCount")))
             (check (= 1 (quasar.protocol:json-value (result second) "documentCount"))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-spec-conflicting-replay-and-gap ()
  (with-temporary-tek9-store (store path "phase2-red-sequence")
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin)))
             (check path)
             (check
              (string= "ok"
                       (status
                        (phase2-spec-send-chunk
                         plane
                         (phase2-spec-chunk session-id 0 (make-doc "seq:1"))))))
             (let ((conflict
                     (phase2-spec-send-chunk
                      plane
                      (phase2-spec-chunk session-id 0 (make-doc "seq:other"))
                      :id "replay-conflict")))
               (check (string= "error" (status conflict)))
               (check (string= "import.chunk-conflict" (error-code conflict))))
             (let ((gap
                     (phase2-spec-send-chunk
                      plane
                      (phase2-spec-chunk session-id 2 (make-doc "seq:gap"))
                      :id "sequence-gap")))
               (check (string= "error" (status gap)))
               (check (string= "import.sequence-gap" (error-code gap)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-spec-abort-after-restart ()
  (let* ((path (unique-tek9-test-path "phase2-red-abort"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:start-control-plane
                          (quasar.control-plane:make-control-plane :store store-1)))
           (setf session-id (phase2-spec-session-id (phase2-spec-begin plane-1)))
           (check
            (string= "ok"
                     (status
                      (phase2-spec-send-chunk
                       plane-1
                       (phase2-spec-chunk session-id 0 (make-doc "abort:1"))))))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2) (phase2-spec-reopen path))
           (check (string= "ok" (status (phase2-spec-abort plane-2 session-id))))
           (check (string= "ok"
                           (status
                            (phase2-spec-abort plane-2 session-id :id "abort-again"))))
           (let ((commit (phase2-spec-commit plane-2 session-id)))
             (check (string= "error" (status commit)))
             (check (string= "import.invalid-session" (error-code commit)))))
      (when plane-1 (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2 (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1 (ignore-errors (quasar.store:close-store store-1)))
      (when store-2 (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-spec-compact-journal ()
  (with-temporary-tek9-store (store path "phase2-red-journal")
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin)))
             (check path)
             (check
              (string= "ok"
                       (status
                        (phase2-spec-send-chunk
                         plane
                         (phase2-spec-chunk session-id 0
                                            (make-doc "journal:1")
                                            (make-doc "journal:2"))))))
             (check (string= "ok" (status (phase2-spec-commit plane session-id))))
             (let* ((entries (quasar.store:store-journal-entries store "default"))
                    (entry (car (last entries))))
               (check entry)
               (check (string= "document.import"
                               (quasar.protocol:json-value entry "command")))
               (check (= 2 (quasar.protocol:json-value entry "documentCount")))
               (check (null (quasar.protocol:json-value entry "encodedChunks")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-phase2-storage-spec-tests ()
  (let ((*failures* 0))
    (test-phase2-spec-direct-document-get)
    (test-phase2-spec-paged-snapshot)
    (test-phase2-spec-stage-is-not-process-local)
    (test-phase2-spec-stage-survives-restart)
    (test-phase2-spec-chunk-replay)
    (test-phase2-spec-conflicting-replay-and-gap)
    (test-phase2-spec-abort-after-restart)
    (test-phase2-spec-compact-journal)
    (when (plusp *failures*)
      (error "~D Phase 2 storage specification tests failed." *failures*))
    t))