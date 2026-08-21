(in-package #:quasar.tests)

(defun phase3-transaction-operation (type payload)
  (quasar.protocol:json-object
   (cons "type" type)
   (cons "payload" payload)))

(defun phase3-mixed-transaction (document-id node-id)
  (quasar.protocol:json-object
   (cons
    "operations"
    (quasar.protocol:json-array
     (phase3-transaction-operation
      "document.create"
      (quasar.protocol:json-object
       (cons "_id" document-id)
       (cons "dtype" "person")))
     (phase3-transaction-operation
      "graph.node.create"
      (quasar.protocol:json-object
       (cons "graphId" "all-documents")
       (cons "id" node-id)
       (cons "documentId" document-id)))))))

(defun test-phase3-failure-atomicity-at-every-commit-boundary ()
  (with-temporary-tek9-store (store path "phase3-failure-boundaries")
    (let* ((plane (quasar.control-plane:make-control-plane :store store))
           (*events-box* (cons nil nil)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (quasar.control-plane:subscribe plane (event-collector))
             (setf (car *events-box*) nil)
             (let ((base-revision
                     (quasar.store:direct-workspace-revision store "default"))
                   (base-journal-count
                     (length
                      (quasar.store:store-journal-entries store "default"))))
               (dolist
                   (failure-point
                    '(:before-mutation-changes
                      :after-mutation-changes
                      :before-mutation-revision
                      :before-mutation-journal
                      :before-commit))
                 (setf
                  (quasar.store:tek9-store-failure-hook store)
                  (lambda (point)
                    (when (eq point failure-point)
                      (error "Injected Phase 3 mutation failure at ~A."
                             failure-point))))
                 (let ((response
                         (call-command
                          plane
                          (make-envelope
                           "workspace.transaction"
                           (phase3-mixed-transaction
                            "atomic-candidate" "atomic-node")
                           :id (format nil "phase3-fail-~A" failure-point)))))
                   (check (string= "error" (status response))))
                 (check
                  (= base-revision
                     (quasar.store:direct-workspace-revision store "default")))
                 (check
                  (= base-journal-count
                     (length
                      (quasar.store:store-journal-entries store "default"))))
                 (check
                  (null
                   (quasar.store:direct-document
                    store "default" "atomic-candidate")))
                 (check
                  (null
                   (quasar.store:direct-graph-node
                    store "default" "all-documents" "atomic-node")))
                 (check (= 0 (length (car *events-box*)))))
               (setf (quasar.store:tek9-store-failure-hook store) nil)
               (let ((response
                       (call-command
                        plane
                        (make-envelope
                         "workspace.transaction"
                         (phase3-mixed-transaction
                          "atomic-candidate" "atomic-node")
                         :id "phase3-failure-retry"))))
                 (check (string= "ok" (status response)))
                 (check
                  (= (1+ base-revision)
                     (quasar.store:direct-workspace-revision store "default")))
                 (check
                  (= (1+ base-journal-count)
                     (length
                      (quasar.store:store-journal-entries store "default"))))
                 (check (= 2 (length (car *events-box*))))
                 (check
                  (quasar.store:direct-document
                   store "default" "atomic-candidate"))
                 (check
                  (quasar.store:direct-graph-node
                   store "default" "all-documents" "atomic-node")))))
        (ignore-errors (quasar.control-plane:stop-control-plane plane))))))

(defun test-phase3-delete-then-reference-in-transaction-fails ()
  (with-temporary-tek9-store (store path "phase3-delete-reference")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (check
              (tek9-command-ok-p
               plane
               "document.create"
               (quasar.protocol:json-object
                (cons "_id" "delete-me")
                (cons "dtype" "person"))
               :id "phase3-delete-reference-seed"))
             (let* ((base
                      (quasar.store:direct-workspace-revision store "default"))
                    (response
                      (call-command
                       plane
                       (make-envelope
                        "workspace.transaction"
                        (quasar.protocol:json-object
                         (cons "expectedRevision" base)
                         (cons
                          "operations"
                          (quasar.protocol:json-array
                           (phase3-transaction-operation
                            "document.delete"
                            (quasar.protocol:json-object
                             (cons "id" "delete-me")))
                           (phase3-transaction-operation
                            "graph.node.create"
                            (quasar.protocol:json-object
                             (cons "graphId" "all-documents")
                             (cons "id" "bad-reference")
                             (cons "documentId" "delete-me"))))))
                        :id "phase3-delete-then-reference"))))
               (check (string= "error" (status response)))
               (check
                (= base
                   (quasar.store:direct-workspace-revision store "default")))
               (check
                (quasar.store:direct-document store "default" "delete-me"))
               (check
                (null
                 (quasar.store:direct-graph-node
                  store "default" "all-documents" "bad-reference")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase3-repeated-document-touch-is-ordered ()
  (with-temporary-tek9-store (store path "phase3-repeated-touch")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (let ((response
                     (call-command
                      plane
                      (make-envelope
                       "workspace.transaction"
                       (quasar.protocol:json-object
                        (cons
                         "operations"
                         (quasar.protocol:json-array
                          (phase3-transaction-operation
                           "document.create"
                           (quasar.protocol:json-object
                            (cons "_id" "ordered")
                            (cons "dtype" "person")
                            (cons "step" 1)))
                          (phase3-transaction-operation
                           "document.update"
                           (quasar.protocol:json-object
                            (cons "_id" "ordered")
                            (cons "dtype" "person")
                            (cons "step" 2)))
                          (phase3-transaction-operation
                           "document.update"
                           (quasar.protocol:json-object
                            (cons "_id" "ordered")
                            (cons "dtype" "person")
                            (cons "step" 3)))))
                       :id "phase3-repeated-touch"))))
               (check (string= "ok" (status response)))
               (check (= 1 (quasar.store:direct-workspace-revision store "default")))
               (let ((document
                       (quasar.store:direct-document
                        store "default" "ordered")))
                 (check document)
                 (check (= 3 (quasar.protocol:json-value document "step"))))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase3-stale-expected-revision-rejected-before-commit ()
  (with-temporary-tek9-store (store path "phase3-stale-revision")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (check
              (tek9-command-ok-p
               plane "document.create"
               (quasar.protocol:json-object
                (cons "_id" "current")
                (cons "dtype" "person"))
               :id "phase3-current"))
             (let ((response
                     (call-command
                      plane
                      (make-envelope
                       "workspace.transaction"
                       (quasar.protocol:json-object
                        (cons "expectedRevision" 0)
                        (cons
                         "operations"
                         (quasar.protocol:json-array
                          (phase3-transaction-operation
                           "document.create"
                           (quasar.protocol:json-object
                            (cons "_id" "stale")
                            (cons "dtype" "person")))))
                       :id "phase3-stale"))))
               (check (string= "error" (status response)))
               (check (= 1 (quasar.store:direct-workspace-revision store "default")))
               (check
                (null (quasar.store:direct-document store "default" "stale")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun phase3-capture-update-working-set (count ordinal)
  (let ((records nil))
    (phase3-with-durable-corpus
     (format nil "phase3-working-set-~D" count)
     count
     (lambda (store plane)
       (declare (ignore store))
       (let ((quasar.control-plane::*mutation-working-set-observer*
               (lambda (metrics)
                 (setf records
                       (quasar.protocol:json-value metrics "records")))))
         (let ((response
                 (call-command
                  plane
                  (make-envelope
                   "document.update"
                   (quasar.protocol:json-object
                    (cons "_id" (phase2-large-corpus-id ordinal))
                    (cons "dtype" "person")
                    (cons "ordinal" ordinal)
                    (cons "bounded" t))
                   :workspace "large-corpus"
                   :id (format nil "phase3-working-set-~D" count)))))
           (check (string= "ok" (status response)))))))
    records))

(defun test-phase3-working-set-independent-of-unrelated-corpus ()
  (let ((small (phase3-capture-update-working-set 1000 999))
        (large (phase3-capture-update-working-set 10000 9999)))
    (check (integerp small))
    (check (integerp large))
    (check (<= small 4))
    (check (<= large 4))
    (check (= small large))
    (format t "~&Phase3 working-set evidence: corpus 1k => ~D records, corpus 10k => ~D records.~%"
            small large)))

(defun phase3-update-operations (count)
  (apply
   #'quasar.protocol:json-array
   (loop
     for ordinal below count
     collect
       (phase3-transaction-operation
        "document.update"
        (quasar.protocol:json-object
         (cons "_id" (phase2-large-corpus-id ordinal))
         (cons "dtype" "person")
         (cons "ordinal" ordinal)
         (cons "txTouched" t))))))

(defun test-phase3-transaction-working-set-scales-with-touched-records ()
  (phase3-with-durable-corpus
   "phase3-transaction-scaling" 10000
   (lambda (store plane)
     (declare (ignore store))
     (dolist (count '(1 4 16))
       (let ((records nil))
         (let ((quasar.control-plane::*mutation-working-set-observer*
                 (lambda (metrics)
                   (setf records
                         (quasar.protocol:json-value metrics "records")))))
           (let ((response
                   (call-command
                    plane
                    (make-envelope
                     "workspace.transaction"
                     (quasar.protocol:json-object
                      (cons "operations" (phase3-update-operations count)))
                     :workspace "large-corpus"
                     :id (format nil "phase3-tx-scale-~D" count)))))
             (check (string= "ok" (status response)))))
         (check (integerp records))
         (check (<= records (+ count 3)))
         (format t "~&Phase3 transaction working set: ~D touched => ~D retained records.~%"
                 count records))))))

(defun test-phase3-restart-after-success-retains_exact_records ()
  (let* ((path (unique-tek9-test-path "phase3-restart-success"))
         (store nil)
         (plane nil))
    (unwind-protect
         (progn
           (setf store (quasar.store:make-tek9-store :path path)
                 plane (quasar.control-plane:make-control-plane :store store))
           (quasar.control-plane:start-control-plane plane)
           (check
            (tek9-command-ok-p
             plane
             "workspace.transaction"
             (phase3-mixed-transaction "restart-doc" "restart-node")
             :id "phase3-restart-commit"))
           (quasar.control-plane:stop-control-plane plane)
           (setf plane nil)
           (quasar.store:close-store store)
           (setf store (quasar.store:make-tek9-store :path path)
                 plane (quasar.control-plane:make-control-plane :store store))
           (quasar.control-plane:start-control-plane plane)
           (check
            (quasar.store:direct-document store "default" "restart-doc"))
           (check
            (quasar.store:direct-graph-node
             store "default" "all-documents" "restart-node"))
           (check (= 1 (quasar.store:direct-workspace-revision store "default")))
           (check
            (= 1
               (length
                (quasar.store:store-journal-entries store "default")))))
      (when plane
        (ignore-errors (quasar.control-plane:stop-control-plane plane)))
      (when store
        (ignore-errors (quasar.store:close-store store)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun run-phase3-adversarial-tests ()
  (let ((*failures* 0))
    (test-phase3-failure-atomicity-at-every-commit-boundary)
    (test-phase3-delete-then-reference-in-transaction-fails)
    (test-phase3-repeated-document-touch-is-ordered)
    (test-phase3-stale-expected-revision-rejected-before-commit)
    (test-phase3-working-set-independent-of-unrelated-corpus)
    (test-phase3-transaction-working-set-scales-with-touched-records)
    (test-phase3-restart-after-success-retains_exact_records)
    (when (plusp *failures*)
      (error "~D Phase 3 adversarial tests failed." *failures*))
    t))
