(in-package #:quasar.tests)

(defun phase3-put-empty-graph (plane graph-id request-id)
  (tek9-command-ok-p
   plane
   "graph.workspace.put"
   (quasar.protocol:json-object
    (cons "id" graph-id)
    (cons "name" graph-id)
    (cons "documentIds" (quasar.protocol:json-array)))
   :id request-id))

(defun phase3-delete-graph-operation (graph-id)
  (phase3-transaction-operation
   "graph.delete"
   (quasar.protocol:json-object (cons "id" graph-id))))

(defun phase3-seed-three-graph-workspace (plane)
  (check (phase3-put-empty-graph plane "a" "phase3-graph-a"))
  (check (phase3-put-empty-graph plane "b" "phase3-graph-b"))
  (check
   (tek9-command-ok-p
    plane
    "graph.workspace.activate"
    (quasar.protocol:json-object (cons "id" "a"))
    :id "phase3-graph-activate-a")))

(defun test-phase3-multi-graph-delete-skips-overlay-tombstones ()
  (with-temporary-tek9-store (store path "phase3-multi-graph-delete")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (phase3-seed-three-graph-workspace plane)
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
                           (phase3-delete-graph-operation "a")
                           (phase3-delete-graph-operation "b"))))
                        :id "phase3-delete-a-b"))))
               (check (string= "ok" (status response)))
               (check
                (= (1+ base)
                   (quasar.store:direct-workspace-revision store "default")))
               (check
                (null
                 (quasar.store:direct-graph-metadata store "default" "a")))
               (check
                (null
                 (quasar.store:direct-graph-metadata store "default" "b")))
               (check
                (quasar.store:direct-graph-metadata
                 store "default" "all-documents"))
               (let ((metadata
                       (quasar.store:direct-workspace-metadata store "default")))
                 (check
                  (string=
                   "all-documents"
                   (quasar.protocol:json-value metadata "activeGraphId"))))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase3-deleting-final-overlay-graph-rolls-back ()
  (with-temporary-tek9-store (store path "phase3-final-graph-delete")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (phase3-seed-three-graph-workspace plane)
             (let* ((base
                      (quasar.store:direct-workspace-revision store "default"))
                    (journal-count
                      (length
                       (quasar.store:store-journal-entries store "default")))
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
                           (phase3-delete-graph-operation "a")
                           (phase3-delete-graph-operation "b")
                           (phase3-delete-graph-operation "all-documents"))))
                        :id "phase3-delete-final-graph"))))
               (check (string= "error" (status response)))
               (check
                (= base
                   (quasar.store:direct-workspace-revision store "default")))
               (check
                (= journal-count
                   (length
                    (quasar.store:store-journal-entries store "default"))))
               (dolist (graph-id '("a" "b" "all-documents"))
                 (check
                  (quasar.store:direct-graph-metadata
                   store "default" graph-id)))
               (let ((metadata
                       (quasar.store:direct-workspace-metadata store "default")))
                 (check
                  (string=
                   "a"
                   (quasar.protocol:json-value metadata "activeGraphId"))))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-phase3-graph-transaction-tests ()
  (let ((*failures* 0))
    (test-phase3-multi-graph-delete-skips-overlay-tombstones)
    (test-phase3-deleting-final-overlay-graph-rolls-back)
    (when (plusp *failures*)
      (error "~D Phase 3 graph transaction tests failed." *failures*))
    t))
