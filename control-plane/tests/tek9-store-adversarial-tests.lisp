(in-package #:quasar.tests)

(defun test-tek9-generated-id-survives-reopen ()
  (let* ((path (unique-tek9-test-path "generated-id"))
         (store nil)
         (plane nil)
         (generated-id nil))
    (unwind-protect
         (progn
           (setf store (quasar.store:make-tek9-store :path path)
                 plane (quasar.control-plane:make-control-plane :store store))
           (quasar.control-plane:start-control-plane plane)
           (let* ((response
                    (call-command
                     plane
                     (make-envelope
                      "document.create"
                      (quasar.protocol:json-object
                       (cons "dtype" "person")
                       (cons "name" "Generated ID"))
                      :id "generated-id-create")))
                  (payload (result response)))
             (check (string= "ok" (status response)))
             (setf generated-id (quasar.protocol:json-value payload "documentId"))
             (check (and (stringp generated-id) (plusp (length generated-id)))))
           (quasar.control-plane:stop-control-plane plane)
           (setf plane nil)
           (quasar.store:close-store store)
           (setf store (quasar.store:make-tek9-store :path path))
           (let ((workspace (quasar.store:load-workspace store "default")))
             (check (gethash generated-id
                             (quasar.workspace:workspace-documents workspace)))))
      (when plane
        (ignore-errors (quasar.control-plane:stop-control-plane plane)))
      (when store
        (ignore-errors (quasar.store:close-store store)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun test-tek9-deletions-restore-exactly ()
  (with-temporary-tek9-store (store path "deletions")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (dolist (document
                      (list (make-doc "person:a" "person")
                            (make-doc "person:b" "person")
                            (make-doc "relation:ab" "relation")))
               (check (string= "ok"
                               (status
                                (call-command plane
                                              (make-envelope "document.create" document))))))
             (let ((graph
                     (quasar.protocol:json-object
                      (cons "id" "delete-g")
                      (cons "name" "Delete Graph")
                      (cons "documentIds"
                            (quasar.protocol:json-array
                             "person:a" "person:b" "relation:ab"))
                      (cons "nodes"
                            (quasar.protocol:json-array
                             (quasar.protocol:json-object
                              (cons "id" "a")
                              (cons "graphId" "delete-g")
                              (cons "documentId" "person:a"))
                             (quasar.protocol:json-object
                              (cons "id" "b")
                              (cons "graphId" "delete-g")
                              (cons "documentId" "person:b"))))
                      (cons "edges"
                            (quasar.protocol:json-array
                             (quasar.protocol:json-object
                              (cons "id" "ab")
                              (cons "graphId" "delete-g")
                              (cons "source" "a")
                              (cons "target" "b")
                              (cons "predicate" "knows")
                              (cons "documentId" "relation:ab")))))))
               (check (string= "ok"
                               (status
                                (call-command
                                 plane
                                 (make-envelope "graph.workspace.put" graph
                                                :id "delete-graph-create"))))))
             (check (string= "ok"
                             (status
                              (call-command
                               plane
                               (make-envelope
                                "graph.edge.delete"
                                (quasar.protocol:json-object
                                 (cons "graphId" "delete-g")
                                 (cons "id" "ab"))
                                :id "delete-edge")))))
             (let* ((durable (quasar.store:load-workspace store "default"))
                    (graph (quasar.workspace:workspace-graph durable "delete-g")))
               (check graph)
               (check (null (quasar.workspace:graph-edge graph "ab"))))
             (check (string= "ok"
                             (status
                              (call-command
                               plane
                               (make-envelope
                                "graph.edge.create"
                                (quasar.protocol:json-object
                                 (cons "id" "ab-2")
                                 (cons "graphId" "delete-g")
                                 (cons "source" "a")
                                 (cons "target" "b")
                                 (cons "predicate" "knows")
                                 (cons "documentId" "relation:ab"))
                                :id "recreate-edge")))))
             (check (string= "ok"
                             (status
                              (call-command
                               plane
                               (make-envelope
                                "graph.node.delete"
                                (quasar.protocol:json-object
                                 (cons "graphId" "delete-g")
                                 (cons "id" "b"))
                                :id "delete-node")))))
             (let* ((durable (quasar.store:load-workspace store "default"))
                    (graph (quasar.workspace:workspace-graph durable "delete-g")))
               (check graph)
               (check (null (quasar.workspace:graph-node graph "b")))
               (check (null (quasar.workspace:graph-edge graph "ab-2"))))
             (check (string= "ok"
                             (status
                              (call-command
                               plane
                               (make-envelope
                                "graph.workspace.delete"
                                (quasar.protocol:json-object (cons "id" "delete-g"))
                                :id "delete-graph")))))
             (let ((durable (quasar.store:load-workspace store "default")))
               (check (null (quasar.workspace:workspace-graph durable "delete-g")))
               (check (gethash "person:a"
                               (quasar.workspace:workspace-documents durable)))
               (check (gethash "relation:ab"
                               (quasar.workspace:workspace-documents durable)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-tek9-durable-base-revision-rejects-stale-candidate ()
  (with-temporary-tek9-store (store path "stale-durable-revision")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (check (string= "ok"
                             (status
                              (call-command plane
                                            (make-envelope
                                             "document.create"
                                             (make-doc "base" "person")
                                             :id "base")))))
             (let ((stale
                     (quasar.workspace:copy-workspace
                      (quasar.store:load-workspace store "default"))))
               (quasar.workspace:dispatch-operation
                stale
                (quasar.protocol:json-object
                 (cons "type" "document.create")
                 (cons "payload" (make-doc "stale" "person"))))
               (incf (quasar.workspace:workspace-revision stale))
               (check (string= "ok"
                               (status
                                (call-command plane
                                              (make-envelope
                                               "document.create"
                                               (make-doc "current" "person")
                                               :id "advance-current")))))
               (let ((rejected nil))
                 (handler-case
                     (quasar.store:commit-workspace
                      store stale
                      (quasar.protocol:json-object
                       (cons "operationId" "stale-direct")
                       (cons "workspaceId" "default")
                       (cons "baseRevision" 1)
                       (cons "committedRevision" 2)))
                   (quasar.protocol:quasar-error ()
                     (setf rejected t)))
                 (check rejected))
               (let ((durable (quasar.store:load-workspace store "default")))
                 (check (= 2 (quasar.workspace:workspace-revision durable)))
                 (check (gethash "current"
                                 (quasar.workspace:workspace-documents durable)))
                 (check (null (gethash "stale"
                                       (quasar.workspace:workspace-documents durable)))))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-tek9-rejects-newer-schema ()
  (let* ((path (unique-tek9-test-path "newer-schema"))
         (store nil)
         (raw nil))
    (unwind-protect
         (progn
           (setf store (quasar.store:make-tek9-store :path path))
           (quasar.store:close-store store)
           (setf store nil
                 raw (tek9:open-database
                      (tek9:new-database "quasar" :path path :durability :full)))
           (tek9:put* raw
                      (quasar.protocol:json-object (cons "version" 999))
                      :id "quasar/schema")
           (tek9:close-database raw)
           (setf raw nil)
           (let ((rejected nil))
             (handler-case
                 (setf store (quasar.store:make-tek9-store :path path))
               (quasar.store:unsupported-storage-schema ()
                 (setf rejected t)))
             (check rejected)))
      (when raw
        (ignore-errors (tek9:close-database raw)))
      (when store
        (ignore-errors (quasar.store:close-store store)))
      (when (probe-file path)
        (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))))

(defun run-tek9-store-adversarial-tests ()
  (test-tek9-generated-id-survives-reopen)
  (test-tek9-deletions-restore-exactly)
  (test-tek9-durable-base-revision-rejects-stale-candidate)
  (test-tek9-rejects-newer-schema)
  t)
