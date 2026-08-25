(in-package #:quasar.tests)

(defun phase3-seed-relation-edge (plane)
  (dolist (document
           (list
            (quasar.protocol:json-object
             (cons "_id" "source-doc")
             (cons "dtype" "person"))
            (quasar.protocol:json-object
             (cons "_id" "target-doc")
             (cons "dtype" "person"))
            (quasar.protocol:json-object
             (cons "_id" "relation-doc")
             (cons "dtype" "relation"))))
    (check
     (tek9-command-ok-p
      plane "document.create" document
      :id (format nil "seed-~A"
                  (quasar.protocol:json-value document "_id")))))
  (dolist (node
           (list
            (quasar.protocol:json-object
             (cons "graphId" "all-documents")
             (cons "id" "source-node")
             (cons "documentId" "source-doc"))
            (quasar.protocol:json-object
             (cons "graphId" "all-documents")
             (cons "id" "target-node")
             (cons "documentId" "target-doc"))))
    (check
     (tek9-command-ok-p
      plane "graph.node.create" node
      :id (format nil "seed-~A"
                  (quasar.protocol:json-value node "id")))))
  (check
   (tek9-command-ok-p
    plane
    "graph.edge.create"
    (quasar.protocol:json-object
     (cons "graphId" "all-documents")
     (cons "id" "relation-edge")
     (cons "source" "source-node")
     (cons "target" "target-node")
     (cons "predicate" "relates-to")
     (cons "documentId" "relation-doc"))
    :id "seed-relation-edge")))

(defun test-phase3-relation-delete-rejects-live-edge-reference ()
  (with-temporary-tek9-store (store path "phase3-relation-live-edge")
    (let* ((plane (quasar.control-plane:make-control-plane :store store))
           (*events-box* (cons nil nil)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (quasar.control-plane:subscribe plane (event-collector))
             (phase3-seed-relation-edge plane)
             (setf (car *events-box*) nil)
             (let* ((base-revision
                      (quasar.store:direct-workspace-revision store "default"))
                    (base-journal-count
                      (length
                       (quasar.store:store-journal-entries store "default")))
                    (response
                      (call-command
                       plane
                       (make-envelope
                        "document.delete"
                        (quasar.protocol:json-object
                         (cons "id" "relation-doc"))
                        :id "delete-live-relation"))))
               (check (string= "error" (status response)))
               (check
                (= base-revision
                   (quasar.store:direct-workspace-revision store "default")))
               (check
                (= base-journal-count
                   (length
                    (quasar.store:store-journal-entries store "default"))))
               (check
                (quasar.store:direct-document
                 store "default" "relation-doc"))
               (check
                (quasar.store:direct-graph-edge
                 store "default" "all-documents" "relation-edge"))
               (check (= 0 (length (car *events-box*)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase3-edge-delete-then-relation-delete-succeeds ()
  (with-temporary-tek9-store (store path "phase3-relation-overlay-delete")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (phase3-seed-relation-edge plane)
             (let* ((base-revision
                      (quasar.store:direct-workspace-revision store "default"))
                    (base-journal-count
                      (length
                       (quasar.store:store-journal-entries store "default")))
                    (response
                      (call-command
                       plane
                       (make-envelope
                        "workspace.transaction"
                        (quasar.protocol:json-object
                         (cons "expectedRevision" base-revision)
                         (cons
                          "operations"
                          (quasar.protocol:json-array
                           (phase3-transaction-operation
                            "graph.edge.delete"
                            (quasar.protocol:json-object
                             (cons "graphId" "all-documents")
                             (cons "id" "relation-edge")))
                           (phase3-transaction-operation
                            "document.delete"
                            (quasar.protocol:json-object
                             (cons "id" "relation-doc"))))))
                        :id "delete-edge-then-relation"))))
               (check (string= "ok" (status response)))
               (check
                (= (1+ base-revision)
                   (quasar.store:direct-workspace-revision store "default")))
               (check
                (= (1+ base-journal-count)
                   (length
                    (quasar.store:store-journal-entries store "default"))))
               (check
                (null
                 (quasar.store:direct-document
                  store "default" "relation-doc")))
               (check
                (null
                 (quasar.store:direct-graph-edge
                  store "default" "all-documents" "relation-edge")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-phase3-relation-integrity-tests ()
  (let ((*failures* 0))
    (test-phase3-relation-delete-rejects-live-edge-reference)
    (test-phase3-edge-delete-then-relation-delete-succeeds)
    (when (plusp *failures*)
      (error "~D Phase 3 relation-integrity tests failed." *failures*))
    t))
