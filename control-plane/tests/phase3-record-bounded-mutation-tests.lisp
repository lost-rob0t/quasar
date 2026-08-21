(in-package #:quasar.tests)

(defun phase3-with-durable-corpus (label count thunk)
  (let* ((path (unique-tek9-test-path label))
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
           (funcall thunk store-2 plane))
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

(defun phase3-assert-no-workspace-corpus-cache (plane)
  (check
   (= 0
      (hash-table-count
       (quasar.control-plane:control-plane-workspaces plane)))))

(defun test-phase3-single-document-update-is-record-bounded ()
  (phase3-with-durable-corpus
   "phase3-update-red" 1000
   (lambda (store plane)
     (declare (ignore store))
     (let* ((id (phase2-large-corpus-id 500))
            (response
              (call-command
               plane
               (make-envelope
                "document.update"
                (quasar.protocol:json-object
                 (cons "_id" id)
                 (cons "dtype" "person")
                 (cons "ordinal" 500)
                 (cons "text" "phase3-updated"))
                :workspace "large-corpus"
                :id "phase3-update"))))
       (check (string= "ok" (status response)))
       (phase3-assert-no-workspace-corpus-cache plane)))))

(defun test-phase3-single-document-create-is-record-bounded ()
  (phase3-with-durable-corpus
   "phase3-create-red" 256
   (lambda (store plane)
     (declare (ignore store))
     (let ((response
             (call-command
              plane
              (make-envelope
               "document.create"
               (quasar.protocol:json-object
                (cons "_id" "phase3-created")
                (cons "dtype" "person"))
               :workspace "large-corpus"
               :id "phase3-create"))))
       (check (string= "ok" (status response)))
       (phase3-assert-no-workspace-corpus-cache plane)))))

(defun test-phase3-single-document-delete-is-record-bounded ()
  (phase3-with-durable-corpus
   "phase3-delete-red" 256
   (lambda (store plane)
     (declare (ignore store))
     (let ((response
             (call-command
              plane
              (make-envelope
               "document.delete"
               (quasar.protocol:json-object
                (cons "id" (phase2-large-corpus-id 128)))
               :workspace "large-corpus"
               :id "phase3-delete"))))
       (check (string= "ok" (status response)))
       (phase3-assert-no-workspace-corpus-cache plane)))))

(defun test-phase3-bounded-transaction-does-not-hydrate-corpus ()
  (phase3-with-durable-corpus
   "phase3-transaction-red" 1000
   (lambda (store plane)
     (declare (ignore store))
     (let* ((operations
              (quasar.protocol:json-array
               (quasar.protocol:json-object
                (cons "type" "document.create")
                (cons "payload"
                      (quasar.protocol:json-object
                       (cons "_id" "phase3-tx-created")
                       (cons "dtype" "person"))))
               (quasar.protocol:json-object
                (cons "type" "document.update")
                (cons "payload"
                      (quasar.protocol:json-object
                       (cons "_id" "phase3-tx-created")
                       (cons "dtype" "person")
                       (cons "text" "read-your-own-write"))))))
            (response
              (call-command
               plane
               (make-envelope
                "workspace.transaction"
                (quasar.protocol:json-object
                 (cons "operations" operations))
                :workspace "large-corpus"
                :id "phase3-transaction"))))
       (check (string= "ok" (status response)))
       (phase3-assert-no-workspace-corpus-cache plane)))))

(defun test-phase3-graph-reference-validation-is-store-backed ()
  (phase3-with-durable-corpus
   "phase3-graph-reference-red" 1000
   (lambda (store plane)
     (declare (ignore store))
     (let ((response
             (call-command
              plane
              (make-envelope
               "graph.node.create"
               (quasar.protocol:json-object
                (cons "id" "phase3-node")
                (cons "graphId" "all-documents")
                (cons "documentId" (phase2-large-corpus-id 999)))
               :workspace "large-corpus"
               :id "phase3-node-create"))))
       (check (string= "ok" (status response)))
       (phase3-assert-no-workspace-corpus-cache plane)))))

(defun test-phase3-ten-thousand-document-mutation-does-not-hydrate-corpus ()
  (phase3-with-durable-corpus
   "phase3-10k-red" 10000
   (lambda (store plane)
     (declare (ignore store))
     (let* ((id (phase2-large-corpus-id 9999))
            (response
              (call-command
               plane
               (make-envelope
                "document.update"
                (quasar.protocol:json-object
                 (cons "_id" id)
                 (cons "dtype" "person")
                 (cons "ordinal" 9999)
                 (cons "text" "bounded-at-10k"))
                :workspace "large-corpus"
                :id "phase3-10k-update"))))
       (check (string= "ok" (status response)))
       (phase3-assert-no-workspace-corpus-cache plane)
       (format
        t
        "~&Phase3 red evidence: one mutation in a 10k durable corpus must retain zero full-workspace cache entries.~%")))))

(defun run-phase3-record-bounded-mutation-tests ()
  (let ((*failures* 0))
    (test-phase3-single-document-update-is-record-bounded)
    (test-phase3-single-document-create-is-record-bounded)
    (test-phase3-single-document-delete-is-record-bounded)
    (test-phase3-bounded-transaction-does-not-hydrate-corpus)
    (test-phase3-graph-reference-validation-is-store-backed)
    (test-phase3-ten-thousand-document-mutation-does-not-hydrate-corpus)
    (when (plusp *failures*)
      (error "~D Phase 3 record-bounded mutation tests failed." *failures*))
    t))