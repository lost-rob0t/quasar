(in-package #:quasar.tests)

(defun phase2-v2-error-code (thunk)
  (handler-case
      (progn (funcall thunk) nil)
    (quasar.protocol:quasar-error (condition)
      (quasar.protocol:quasar-error-code condition))))

(defun phase2-v2-import-event-count ()
  (count-if
   (lambda (encoded)
     (search "\"event\":\"documents.imported\"" encoded))
   (car *events-box*)))

(defun test-phase2-v2-revision-conflict-after-restart ()
  (let* ((path (unique-tek9-test-path "phase2-conflict-restart"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1
                 (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store-1)))
           (check
            (tek9-command-ok-p
             plane-1 "document.create" (make-doc "base") :id "conflict-base"))
           (setf session-id
                 (phase2-spec-session-id (phase2-spec-begin plane-1)))
           (check
            (string=
             "ok"
             (status
              (phase2-spec-send-chunk
               plane-1
               (phase2-spec-chunk
                session-id 0 (make-doc "staged-conflict"))))))
           (check
            (tek9-command-ok-p
             plane-1
             "document.create"
             (make-doc "concurrent")
             :id "conflict-concurrent"))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2)
             (phase2-spec-reopen path))
           (setf *events-box* (cons nil nil))
           (let ((subscriber-id
                   (quasar.control-plane:subscribe
                    plane-2 (event-collector))))
             (unwind-protect
                  (let ((response
                          (phase2-spec-commit plane-2 session-id)))
                    (check (string= "error" (status response)))
                    (check
                     (string=
                      "workspace.revision-conflict"
                      (error-code response)))
                    (check
                     (= 2
                        (quasar.store:direct-workspace-revision
                         store-2 "default")))
                    (check
                     (string=
                      "document.not-found"
                      (error-code
                       (call-command
                        plane-2
                        (make-envelope
                         "document.get"
                         (quasar.protocol:json-object
                          (cons "id" "staged-conflict"))
                         :id "conflict-staged-missing")))))
                    (check
                     (string=
                      "ok"
                      (status
                       (call-command
                        plane-2
                        (make-envelope
                         "document.get"
                         (quasar.protocol:json-object
                          (cons "id" "concurrent"))
                         :id "conflict-concurrent-present")))))
                    (check (= 0 (phase2-v2-import-event-count)))
                    (check
                     (notany
                      (lambda (entry)
                        (string=
                         "document.import"
                         (or
                          (quasar.protocol:json-value entry "command")
                          "")))
                      (quasar.store:store-journal-entries
                       store-2 "default")))
                    (let ((retry
                            (phase2-spec-commit
                             plane-2 session-id :id "conflict-retry")))
                      (check (string= "error" (status retry)))
                      (check
                       (string=
                        "import.invalid-session"
                        (error-code retry)))))
               (quasar.control-plane:unsubscribe
                plane-2 subscriber-id))))
      (when plane-1
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-v2-commit-replay-emits-once ()
  (with-temporary-tek9-store (store path "phase2-commit-replay")
    (check (probe-file path))
    (let ((plane
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store))))
      (setf *events-box* (cons nil nil))
      (let ((subscriber-id
              (quasar.control-plane:subscribe plane (event-collector))))
        (unwind-protect
             (let* ((session-id
                      (phase2-spec-session-id (phase2-spec-begin plane)))
                    (chunk
                      (phase2-spec-chunk
                       session-id 0 (make-doc "replay-commit"))))
               (check
                (string=
                 "ok"
                 (status (phase2-spec-send-chunk plane chunk))))
               (let ((first (phase2-spec-commit plane session-id)))
                 (check (string= "ok" (status first)))
                 (check
                  (not
                   (eq t
                       (quasar.protocol:json-value
                        (result first) "replayed" nil)))))
               (let ((journal-count
                       (length
                        (quasar.store:store-journal-entries
                         store "default"))))
                 (let ((second
                         (phase2-spec-commit
                          plane session-id :id "commit-replay")))
                   (check (string= "ok" (status second)))
                   (check
                    (eq t
                        (quasar.protocol:json-value
                         (result second) "replayed" nil))))
                 (check
                  (= journal-count
                     (length
                      (quasar.store:store-journal-entries
                       store "default")))))
               (sleep 0.1)
               (check (= 1 (phase2-v2-import-event-count))))
          (quasar.control-plane:unsubscribe plane subscriber-id)
          (quasar.control-plane:stop-control-plane plane))))))

(defun phase2-v2-run-promotion-fault (fault-point)
  (let* ((path
           (unique-tek9-test-path
            (format nil "phase2-promote-fault-~A" fault-point)))
         (armed nil)
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1
                 (quasar.store:make-tek9-store
                  :path path
                  :failure-hook
                  (lambda (point)
                    (when (and armed (eq point fault-point))
                      (error "Injected Phase 2 promotion fault at ~A."
                             point))))
                 plane-1
                 (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store-1)))
           (check
            (tek9-command-ok-p
             plane-1
             "document.create"
             (make-doc "fault-base")
             :id "fault-base"))
           (setf session-id
                 (phase2-spec-session-id (phase2-spec-begin plane-1)))
           (check
            (string=
             "ok"
             (status
              (phase2-spec-send-chunk
               plane-1
               (phase2-spec-chunk
                session-id 0
                (make-doc "fault-import-1")
                (make-doc "fault-import-2"))))))
           (setf armed t)
           (let ((failed
                   (phase2-spec-commit
                    plane-1 session-id :id "faulted-promotion")))
             (check (string= "error" (status failed))))
           (setf armed nil)
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2)
             (phase2-spec-reopen path))
           (check
            (= 1
               (quasar.store:direct-workspace-revision
                store-2 "default")))
           (dolist (id '("fault-import-1" "fault-import-2"))
             (check
              (string=
               "document.not-found"
               (error-code
                (call-command
                 plane-2
                 (make-envelope
                  "document.get"
                  (quasar.protocol:json-object (cons "id" id))
                  :id (format nil "missing-~A" id)))))))
           (let ((retry
                   (phase2-spec-commit
                    plane-2 session-id :id "promotion-retry")))
             (check (string= "ok" (status retry)))
             (check
              (= 2
                 (quasar.protocol:json-value
                  (result retry) "documentCount"))))
           (check
            (= 2
               (quasar.store:direct-workspace-revision
                store-2 "default"))))
      (when plane-1
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-v2-promotion-failure-matrix ()
  (dolist (point '(:before-import-promotion
                   :before-import-revision
                   :before-import-journal
                   :before-import-finalize))
    (phase2-v2-run-promotion-fault point)))

(defun phase2-v2-run-chunk-fault (fault-point)
  (let* ((path
           (unique-tek9-test-path
            (format nil "phase2-chunk-fault-~A" fault-point)))
         (armed nil)
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id payload)
           (setf store-1
                 (quasar.store:make-tek9-store
                  :path path
                  :failure-hook
                  (lambda (point)
                    (when (and armed (eq point fault-point))
                      (error "Injected Phase 2 chunk fault at ~A." point))))
                 plane-1
                 (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store-1)))
           (setf session-id
                 (phase2-spec-session-id (phase2-spec-begin plane-1))
                 payload
                 (phase2-spec-chunk
                  session-id 0 (make-doc "chunk-fault-doc")))
           (setf armed t)
           (let ((failed
                   (phase2-spec-send-chunk
                    plane-1 payload :id "faulted-chunk")))
             (check (string= "error" (status failed))))
           (setf armed nil)
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2)
             (phase2-spec-reopen path))
           (let ((retry
                   (phase2-spec-send-chunk
                    plane-2 payload :id "chunk-retry")))
             (check (string= "ok" (status retry)))
             (check
              (= 1
                 (quasar.protocol:json-value
                  (result retry) "documentCount"))))
           (check
            (string=
             "ok"
             (status (phase2-spec-commit plane-2 session-id)))))
      (when plane-1
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-v2-chunk-failure-matrix ()
  (dolist (point '(:before-import-chunk
                   :after-import-documents
                   :before-import-metadata))
    (phase2-v2-run-chunk-fault point)))

(defun phase2-v2-page-document-ids (snapshot)
  (mapcar
   (lambda (document)
     (quasar.protocol:json-value document "_id"))
   (array-elements-for-test
    (quasar.protocol:json-value snapshot "documents"))))

(defun test-phase2-v2-pagination-property ()
  (let* ((path (unique-tek9-test-path "phase2-page-property"))
         (store nil)
         (reopened nil)
         (workspace (make-workspace :id "page-property"))
         (expected nil))
    (unwind-protect
         (progn
           (dotimes (index 500)
             (let ((id (format nil "doc:~6,'0D" index)))
               (push id expected)
               (setf
                (gethash id (workspace-documents workspace))
                (quasar.protocol:json-object
                 (cons "_id" id)
                 (cons "dtype" "person")
                 (cons "text"
                       (format nil
                               "unicode-~D-λ-雪-~A"
                               index
                               (make-string
                                (mod index 37)
                                :initial-element #\x)))))))
           (setf expected (sort expected #'string<)
                 store (quasar.store:make-tek9-store :path path))
           (quasar.store:save-workspace store workspace)
           (quasar.store:close-store store)
           (setf store nil
                 reopened (quasar.store:make-tek9-store :path path))
           (dolist (byte-limit '(256 511 1024 4096))
             (let ((offset 0)
                   (seen nil)
                   (pages 0)
                   (done nil))
               (loop
                 until done
                 do
                   (let* ((snapshot
                            (quasar.store:direct-workspace-snapshot-page
                             reopened "page-property" offset byte-limit))
                          (page
                            (quasar.protocol:json-value
                             snapshot "documentPage"))
                          (ids (phase2-v2-page-document-ids snapshot))
                          (next
                            (quasar.protocol:json-value
                             page "nextOffset")))
                     (incf pages)
                     (setf seen (nconc seen ids))
                     (check (> next offset))
                     (setf offset next
                           done
                           (eq t
                               (quasar.protocol:json-value
                                page "complete")))))
               (check (> pages 1))
               (check (= 500 (length seen)))
               (check
                (= 500
                   (length
                    (remove-duplicates seen :test #'string=))))
               (check (equal expected seen)))))
      (when store
        (ignore-errors (quasar.store:close-store store)))
      (when reopened
        (ignore-errors (quasar.store:close-store reopened)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun test-phase2-v2-expiry-and-workspace-isolation ()
  (with-temporary-tek9-store (store path "phase2-expiry")
    (check (probe-file path))
    (quasar.store:begin-import-stage
     store "workspace-a" "same-stage" 0 100)
    (quasar.store:begin-import-stage
     store "workspace-b" "same-stage" 0 180)
    (check
     (= 1
        (quasar.store:cleanup-expired-import-stages
         store 200 :ttl-seconds 50)))
    (check
     (string=
      "import.invalid-session"
      (phase2-v2-error-code
       (lambda ()
         (quasar.store:accept-import-chunk
          store
          "workspace-a"
          "same-stage"
          0
          (quasar.protocol:json-array)
          201)))))
    (check
     (null
      (phase2-v2-error-code
       (lambda ()
         (quasar.store:accept-import-chunk
          store
          "workspace-b"
          "same-stage"
          0
          (quasar.protocol:json-array)
          201)))))
    (check
     (= 1
        (quasar.store:cleanup-expired-import-stages
         store 400 :ttl-seconds 50)))
    (check
     (string=
      "import.invalid-session"
      (phase2-v2-error-code
       (lambda ()
         (quasar.store:accept-import-chunk
          store
          "workspace-b"
          "same-stage"
          1
          (quasar.protocol:json-array)
          401)))))))

#+sbcl
(defun phase2-v2-force-full-gc ()
  (sb-ext:gc :full t))

#-sbcl
(defun phase2-v2-force-full-gc ()
  nil)

#+sbcl
(defun phase2-v2-dynamic-usage ()
  (sb-kernel:dynamic-usage))

#-sbcl
(defun phase2-v2-dynamic-usage ()
  0)

(defun phase2-v2-padding-chunk (start count padding-size)
  (apply
   #'quasar.protocol:json-array
   (loop
     for index from start below (+ start count)
     for id = (format nil "mem:~8,'0D" index)
     collect
       (quasar.protocol:json-object
        (cons "type" "document.create")
        (cons
         "payload"
         (quasar.protocol:json-object
          (cons "_id" id)
          (cons "dtype" "person")
          (cons
           "padding"
           (make-string padding-size :initial-element #\m))))))))

(defun test-phase2-v2-bounded-retained-memory ()
  (with-temporary-tek9-store (store path "phase2-memory")
    (check (probe-file path))
    (quasar.store:begin-import-stage store "memory" "stage" 0 100)
    (let ((sequence 0))
      (labels ((stage-range (start end)
                 (loop
                   for first from start below end by 50
                   for count = (min 50 (- end first))
                   do
                     (quasar.store:accept-import-chunk
                      store
                      "memory"
                      "stage"
                      sequence
                      (phase2-v2-padding-chunk first count 2048)
                      (+ 100 sequence))
                     (incf sequence))))
        (stage-range 0 500)
        (phase2-v2-force-full-gc)
        (let ((small (phase2-v2-dynamic-usage)))
          (stage-range 500 5000)
          (phase2-v2-force-full-gc)
          (let* ((large (phase2-v2-dynamic-usage))
                 (growth (max 0 (- large small)))
                 (threshold (* 8 1024 1024)))
            (format
             t
             "~&Phase2 memory evidence: 500 -> 5000 staged docs, small=~D large=~D growth=~D threshold=~D bytes~%"
             small large growth threshold)
            #+sbcl
            (check (< growth threshold))))))))

(defun run-phase2-adversarial-v2-tests ()
  (let ((*failures* 0))
    (test-phase2-v2-revision-conflict-after-restart)
    (test-phase2-v2-commit-replay-emits-once)
    (test-phase2-v2-promotion-failure-matrix)
    (test-phase2-v2-chunk-failure-matrix)
    (test-phase2-v2-pagination-property)
    (test-phase2-v2-expiry-and-workspace-isolation)
    (test-phase2-v2-bounded-retained-memory)
    (when (plusp *failures*)
      (error "~D Phase 2 adversarial v2 tests failed." *failures*))
    t))