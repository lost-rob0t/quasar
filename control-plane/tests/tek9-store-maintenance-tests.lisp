(in-package #:quasar.tests)

(defun test-full-save-removes-superseded-graph-topology ()
  (with-temporary-tek9-store (store path "full-save-cleanup")
    (let* ((workspace-id "replacement")
           (workspace (quasar.workspace:make-workspace :id workspace-id))
           (graph-id "old-graph")
           (graph
             (quasar.protocol:json-object
              (cons "id" graph-id)
              (cons "name" "Old graph")
              (cons "documentIds" (quasar.protocol:json-array "person:old"))
              (cons "nodes"
                    (quasar.protocol:json-array
                     (quasar.protocol:json-object
                      (cons "id" "old-node")
                      (cons "graphId" graph-id)
                      (cons "documentId" "person:old"))))
              (cons "edges" (quasar.protocol:json-array))))
           (database (quasar.store::tek9-store-database store))
           (namespace (quasar.store::%graph-namespace workspace-id graph-id)))
      (setf (gethash "person:old" (quasar.workspace:workspace-documents workspace))
            (make-doc "person:old" "person")
            (quasar.workspace:workspace-graph workspace graph-id) graph)
      (quasar.store:save-workspace store workspace)
      (check (= 1 (length (tek9:fetch-graph-nodes database namespace))))
      (let ((replacement (quasar.workspace:make-workspace :id workspace-id)))
        (quasar.store:save-workspace store replacement)
        (check (null (quasar.workspace:workspace-graph
                      (quasar.store:load-workspace store workspace-id)
                      graph-id)))
        (check (null (tek9:fetch-graph-nodes database namespace)))
        (check (null (tek9:fetch-graph-edges database namespace)))))))

(defun run-tek9-store-maintenance-tests ()
  (test-full-save-removes-superseded-graph-topology)
  t)
