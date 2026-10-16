(in-package #:quasar.tests)

(defun overlay-test-envelope ()
  (quasar.protocol:decode-command
   (make-envelope "workspace.transaction" (quasar.protocol:empty-object))))

(defun overlay-test-operation (plane type payload)
  (quasar.control-plane::run-operation plane (overlay-test-envelope)
                                       (phase3-transaction-operation type payload)))

(defun overlay-test-transaction (plane &rest operations)
  (quasar.control-plane::handle-transaction
   plane (quasar.protocol:json-object
          (cons "operations" (apply #'quasar.protocol:json-array operations)))
   (overlay-test-envelope)))

(defun overlay-test-durable-state (store)
  ;; Small fixtures only: compare all canonical records, accounting and journal.
  (let ((db (quasar.store::tek9-store-database store)))
    (list
     (quasar.protocol:encode (apply #'quasar.protocol:json-array
                             (quasar.store::%range-values db (quasar.store::%workspace-prefix "default"))))
     (quasar.protocol:encode (tek9:fetch* db (quasar.store::%quota-key "default")))
     (quasar.protocol:encode (apply #'quasar.protocol:json-array
                             (quasar.store::%range-values db "quasar/v1/quota-graph/"))))))

(defun overlay-test-seed-zero (store)
  (let* ((workspace (make-workspace))
         (graph (workspace-graph workspace "all-documents")))
    (quasar.protocol:object-set graph "name" "Durable revision zero")
    (quasar.protocol:object-set graph "positions"
     (quasar.protocol:json-object (cons "n1" (quasar.protocol:json-object (cons "x" 17)))))
    (quasar.protocol:object-set graph "nodes"
     (quasar.protocol:json-array (make-node "all-documents" "n1") (make-node "all-documents" "n2")))
    (quasar.protocol:object-set graph "edges"
     (quasar.protocol:json-array
      (quasar.protocol:json-object (cons "id" "e1") (cons "graphId" "all-documents")
                                  (cons "source" "n1") (cons "target" "n2"))))
    (quasar.store:save-workspace store workspace)))

(defun test-overlay-restore-collision-is-atomic ()
  (with-temporary-tek9-store (store path "restore-collision")
    (overlay-test-seed-zero store)
    (let* ((plane (quasar.control-plane:make-control-plane :store store))
           (before (overlay-test-durable-state store)) (events nil))
      (quasar.control-plane:subscribe plane (lambda (event) (push event events)))
      (check
       (string= "transaction.failed"
        (phase2-v2-error-code
         (lambda ()
           (overlay-test-transaction plane
            (phase3-transaction-operation "graph.node.restore"
             (quasar.protocol:json-object
              (cons "node" (make-node "all-documents" "restored"))
              (cons "edges" (quasar.protocol:json-array
               (quasar.protocol:json-object
                (cons "id" "e1") (cons "graphId" "all-documents")
                (cons "source" "restored") (cons "target" "n2")))))))))))
      (check (equal before (overlay-test-durable-state store)))
      (check (null events))
      (check (null (quasar.store:direct-graph-node store "default" "all-documents" "restored")))
      (assert-mutation-quota-exact store "default"))))

(defun test-overlay-zero-revision-preserves-durable-graph ()
  (with-temporary-tek9-store (store path "zero-revision-graph")
    (overlay-test-seed-zero store)
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (check (string= "graph.duplicate-id"
              (phase2-v2-error-code
               (lambda () (overlay-test-operation plane "graph.node.create"
                            (make-node "all-documents" "n1"))))))
      (check (zerop (quasar.store:direct-workspace-revision store "default")))
      (overlay-test-operation plane "graph.node.create" (make-node "all-documents" "n3"))
      (let* ((restored (quasar.store:load-workspace store "default"))
             (graph (workspace-graph restored "all-documents")))
        (check (= 3 (length (quasar.workspace:array-elements (quasar.workspace:graph-nodes graph)))))
        (check (graph-edge graph "e1"))
        (check (string= "Durable revision zero" (quasar.protocol:json-value graph "name")))
        (check (= 17 (quasar.protocol:json-value
                     (quasar.protocol:json-value (quasar.protocol:json-value graph "positions") "n1") "x"))))
      (assert-mutation-quota-exact store "default"))))

(defun test-overlay-implicit-graph-create-delete ()
  (with-temporary-tek9-store (store path "implicit-graph-create-delete")
    (let ((plane (quasar.control-plane:make-control-plane :store store)) (events nil))
      (overlay-test-operation plane "document.create" (make-doc "seed"))
      (quasar.control-plane:subscribe plane (lambda (event) (push event events)))
      (overlay-test-transaction plane
       (phase3-transaction-operation "graph.node.create" (make-node "scratch" "n"))
       (phase3-delete-graph-operation "scratch"))
      (check (= 2 (quasar.store:direct-workspace-revision store "default")))
      (check (= 2 (length events)))
      (check (null (quasar.store:direct-graph-metadata store "default" "scratch")))
      (check (quasar.store:direct-graph-metadata store "default" "all-documents"))
      (assert-mutation-quota-exact store "default"))))

(defun call-with-no-corpus-ranges (thunk)
  (let ((original (symbol-function 'quasar.store::%bounded-range)))
    (unwind-protect
         (progn
           (setf (symbol-function 'quasar.store::%bounded-range)
            (lambda (database prefix &rest arguments)
              (when (or (search "/doc/" prefix) (search "/node/" prefix)
                        (search "/edge/" prefix) (search "/journal/" prefix)
                        (equal prefix "quasar/v1/ws/"))
                (error "Unexpected corpus/topology range during bounded mutation: ~A" prefix))
              (apply original database prefix arguments)))
           (funcall thunk))
      (setf (symbol-function 'quasar.store::%bounded-range) original))))

(defun test-quota-legacy-migration-and-cold-mutation ()
  (with-temporary-tek9-store (store path "quota-legacy")
    (overlay-test-seed-zero store)
    (let ((db (quasar.store::tek9-store-database store)))
      ;; Simulate a pre-accounting durable store, including a revision-zero graph.
      (tek9:with-write-transaction (db)
        (tek9:delete-document db quasar.store::+quota-migration-key+)
        (tek9:delete-document db (quasar.store::%quota-key "default"))
        (tek9:delete-document db (quasar.store::%quota-graph-key "default" "all-documents")))
      (setf (quasar.store:tek9-store-failure-hook store)
            (lambda (point) (when (eq point :before-quota-migration-commit) (error "migration failure"))))
      (check (handler-case (progn (quasar.store::migrate-quota-accounting store) nil) (error () t)))
      (check (null (tek9:fetch* db quasar.store::+quota-migration-key+)))
      (check (null (tek9:fetch* db (quasar.store::%quota-key "default"))))
      (check (null (tek9:fetch* db (quasar.store::%quota-graph-key "default" "all-documents")))))
    (quasar.store:close-store store)
    (setf store (quasar.store:make-tek9-store :path path))
    (assert-mutation-quota-exact store "default")
    (check (zerop (quasar.store:direct-workspace-revision store "default")))
    (check (null (quasar.store:store-journal-entries store "default")))
    ;; Reopening migrated storage and mutating it must not scan legacy data.
    (quasar.store:close-store store)
    (call-with-no-corpus-ranges
     (lambda ()
       (setf store (quasar.store:make-tek9-store :path path))
       (overlay-test-operation (quasar.control-plane:make-control-plane :store store)
                               "graph.node.create" (make-node "all-documents" "after-reopen"))))
    (assert-mutation-quota-exact store "default")))

(defun test-quota-import-delta-rejection-retry-reopen ()
  (with-temporary-tek9-store (store path "quota-import-delta")
    (let* ((plane (quasar.control-plane:make-control-plane :store store))
           (envelope (overlay-test-envelope))
           (stage-id "quota-stage") (events nil))
      (overlay-test-operation plane "document.create" (make-doc "existing"))
      (quasar.control-plane:subscribe plane (lambda (event) (push event events)))
      (quasar.store:begin-import-stage store "default" stage-id 1 (get-universal-time))
      (quasar.store:accept-import-chunk store "default" stage-id 0
       (quasar.protocol:json-array
        (phase3-transaction-operation "document.update"
         (phase3-document (cons "id" "existing") (cons "dtype" "person") (cons "notes" "雪λ")))
        (phase3-transaction-operation "document.create" (make-doc "imported")))
       (get-universal-time))
      (let ((before (overlay-test-durable-state store))
            (quasar.control-plane::*command-principal* "import-quota"))
        (unwind-protect
             (progn
               (quasar.plugin:set-storage-quota-resolver (lambda (principal) (declare (ignore principal)) 1))
               (check (string= "storage.quota-exceeded"
                       (phase2-v2-error-code
                        (lambda () (quasar.control-plane::handle-import-commit plane
                                    (quasar.protocol:json-object (cons "sessionId" stage-id)) envelope)))))
               (check (equal before (overlay-test-durable-state store)))
               (check (null events))
               (quasar.plugin:set-storage-quota-resolver (lambda (principal) (declare (ignore principal)) 1000000))
               (quasar.control-plane::handle-import-commit plane
                (quasar.protocol:json-object (cons "sessionId" stage-id)) envelope)
               (check (= 1 (length events)))
               (quasar.control-plane::handle-import-commit plane
                (quasar.protocol:json-object (cons "sessionId" stage-id)) envelope)
               (check (= 1 (length events))))
          (quasar.plugin:reset-plugin-policy)))
      (assert-mutation-quota-exact store "default")
      (quasar.store:close-store store)
      (call-with-no-corpus-ranges
       (lambda ()
         (setf store (quasar.store:make-tek9-store :path path))
         (overlay-test-operation (quasar.control-plane:make-control-plane :store store)
                                "graph.node.create" (make-node "all-documents" "after-import"))))
      (assert-mutation-quota-exact store "default"))))

(defun run-mutation-overlay-regression-tests ()
  (test-overlay-restore-collision-is-atomic)
  (test-overlay-zero-revision-preserves-durable-graph)
  (test-overlay-implicit-graph-create-delete)
  (test-quota-legacy-migration-and-cold-mutation)
  (test-quota-import-delta-rejection-retry-reopen))
