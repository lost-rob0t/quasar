(in-package #:quasar.tests)

;;; Compact dataset/graph catalog maintenance, legacy migration, and bounded
;;; graph membership paging (docs/BOUNDED-WORKBENCH.md phase 2 backend).

(defun catalog-document (id dataset)
  (quasar.protocol:json-object
   (cons "id" id)
   (cons "dtype" "person")
   (cons "dataset" dataset)
   (cons "schemaVersion" "0.10.1")
   (cons "updatedAt" 1)))

(defun catalog-datasets (bootstrap)
  (array-elements-for-test (quasar.protocol:json-value bootstrap "datasets")))

(defun catalog-graphs (bootstrap)
  (array-elements-for-test (quasar.protocol:json-value bootstrap "graphs")))

(defun catalog-dataset-count (bootstrap name)
  (loop for row in (catalog-datasets bootstrap)
        when (string= name (quasar.protocol:json-value row "name"))
          return (quasar.protocol:json-value row "documentCount")))

(defun catalog-graph-row (bootstrap graph-id)
  (loop for row in (catalog-graphs bootstrap)
        when (string= graph-id (quasar.protocol:json-value row "id"))
          return row))

(defun catalog-plane-command (plane command payload &key (workspace "default"))
  (let ((response (call-command plane (make-envelope command payload
                                                     :id (format nil "catalog-~A" command)
                                                     :workspace workspace))))
    (check (string= "ok" (status response)))
    response))

(defun test-catalog-maintenance-through-commits ()
  "Every committed mutation keeps dataset and graph catalog rows exact."
  (with-temporary-tek9-store (store path "catalog-maintenance")
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (flet ((bootstrap ()
               (quasar.store:workspace-bootstrap store "default")))
        (unwind-protect
             (progn
               (catalog-plane-command plane "document.create" (catalog-document "person:1" "alpha"))
               (catalog-plane-command plane "document.create" (catalog-document "person:2" "alpha"))
               (catalog-plane-command plane "document.create" (catalog-document "org:1" "beta"))
               (let ((bootstrap (bootstrap)))
                 (check (= 2 (catalog-dataset-count bootstrap "alpha")))
                 (check (= 1 (catalog-dataset-count bootstrap "beta")))
                 (check (eq t (quasar.protocol:json-value bootstrap "datasetsComplete")))
                 ;; New workspaces carry the default all-documents graph row.
                 (let ((rows (catalog-graphs bootstrap)))
                   (check (= 1 (length rows)))
                   (check (equal "all-documents" (quasar.protocol:json-value (first rows) "id")))
                   (check (= 0 (quasar.protocol:json-value (first rows) "nodeCount")))))
               ;; A dataset move adjusts both rows in one commit.
               (catalog-plane-command plane "document.update" (catalog-document "person:1" "beta"))
               (let ((bootstrap (bootstrap)))
                 (check (= 1 (catalog-dataset-count bootstrap "alpha")))
                 (check (= 2 (catalog-dataset-count bootstrap "beta"))))
               (catalog-plane-command plane "document.delete"
                                      (quasar.protocol:json-object (cons "id" "org:1")))
               (let ((bootstrap (bootstrap)))
                 (check (= 1 (catalog-dataset-count bootstrap "beta")))
                 (check (null (catalog-dataset-count bootstrap "gamma"))))
               ;; Graph lifecycle: put, membership edits, rename, delete.
               (let ((graph (quasar.protocol:json-object
                             (cons "id" "case")
                             (cons "name" "Case Graph")
                             (cons "documentIds"
                                   (quasar.protocol:json-array "person:1" "person:2"))
                             (cons "nodes"
                                   (quasar.protocol:json-array
                                    (quasar.protocol:json-object
                                     (cons "id" "n1") (cons "graphId" "case")
                                     (cons "documentId" "person:1"))
                                    (quasar.protocol:json-object
                                     (cons "id" "n2") (cons "graphId" "case")
                                     (cons "documentId" "person:2"))))
                             (cons "edges"
                                   (quasar.protocol:json-array
                                    (quasar.protocol:json-object
                                     (cons "id" "e1") (cons "graphId" "case")
                                     (cons "source" "n1") (cons "target" "n2")))))))
                 (catalog-plane-command plane "graph.workspace.put" graph)
                 (let* ((bootstrap (bootstrap))
                        (row (catalog-graph-row bootstrap "case")))
                   (check (equal "Case Graph" (quasar.protocol:json-value row "name")))
                   (check (= 2 (quasar.protocol:json-value row "nodeCount")))
                   (check (= 1 (quasar.protocol:json-value row "edgeCount"))))
                 (catalog-plane-command plane "document.create" (catalog-document "person:3" "alpha"))
                 (catalog-plane-command plane "graph.node.create" (make-node "case" "n3" "person:3"))
                 (let ((row (catalog-graph-row (bootstrap) "case")))
                   (check (= 3 (quasar.protocol:json-value row "nodeCount"))))
                 (catalog-plane-command plane "graph.node.delete"
                                        (quasar.protocol:json-object
                                         (cons "graphId" "case") (cons "id" "n3")))
                 (let ((row (catalog-graph-row (bootstrap) "case")))
                   (check (= 2 (quasar.protocol:json-value row "nodeCount"))))
                 (catalog-plane-command plane "graph.edge.create" (make-edge "case" "e2" "n2" "n1"))
                 (let ((row (catalog-graph-row (bootstrap) "case")))
                   (check (= 2 (quasar.protocol:json-value row "edgeCount"))))
                 (catalog-plane-command plane "graph.edge.delete"
                                        (quasar.protocol:json-object
                                         (cons "graphId" "case") (cons "id" "e2")))
                 (let ((row (catalog-graph-row (bootstrap) "case")))
                   (check (= 1 (quasar.protocol:json-value row "edgeCount"))))
                 ;; A full replace recomputes counts and refreshes the name.
                 (quasar.protocol:object-set graph "name" "Renamed")
                 (catalog-plane-command plane "graph.workspace.put" graph)
                 (let* ((bootstrap (bootstrap))
                        (row (catalog-graph-row bootstrap "case")))
                   (check (equal "Renamed" (quasar.protocol:json-value row "name")))
                   (check (= 2 (quasar.protocol:json-value row "nodeCount")))
                   (check (= 1 (quasar.protocol:json-value row "edgeCount"))))
                 (catalog-plane-command plane "graph.workspace.delete"
                                        (quasar.protocol:json-object (cons "id" "case")))
                 (check (null (catalog-graph-row (bootstrap) "case"))))
               ;; The bootstrap envelope stays bounded with catalogs included.
               (check (<= (quasar.store::%utf8-length
                           (quasar.protocol:encode (bootstrap)))
                          (* 512 1024))))
          (quasar.control-plane:stop-control-plane plane))))))

(defun test-catalog-legacy-migration ()
  "A workspace stored before catalogs gains exact rows on first bootstrap."
  (with-temporary-tek9-store (store path "catalog-migration")
    (let ((workspace (make-workspace :id "legacy")))
      (quasar.workspace:apply-document-create workspace (catalog-document "person:1" "alpha"))
      (quasar.workspace:apply-document-create workspace (catalog-document "person:2" "alpha"))
      (quasar.workspace:apply-document-create workspace (catalog-document "org:1" "beta"))
      (quasar.workspace:apply-graph-put
       workspace
       (quasar.protocol:json-object
        (cons "id" "old")
        (cons "name" "Old Graph")
        (cons "documentIds" (quasar.protocol:json-array "person:1" "person:2"))
        (cons "nodes"
              (quasar.protocol:json-array
               (quasar.protocol:json-object
                (cons "id" "n1") (cons "graphId" "old") (cons "documentId" "person:1"))
               (quasar.protocol:json-object
                (cons "id" "n2") (cons "graphId" "old") (cons "documentId" "person:2"))))))
      (quasar.store:save-workspace store workspace)
      ;; Strip every catalog row plus the marker: durable state is exactly
      ;; what a pre-catalog Quasar version would have left on disk.
      (let ((database (quasar.store::tek9-store-database store)))
        (tek9:with-write-transaction (database)
          (quasar.store::%delete-prefix database (quasar.store::%dataset-catalog-prefix "legacy"))
          (quasar.store::%delete-prefix database (quasar.store::%graph-catalog-prefix "legacy"))
          (tek9:delete-document database (quasar.store::%catalog-marker-key "legacy"))))
      (let ((bootstrap (quasar.store:workspace-bootstrap store "legacy")))
        (check (= 2 (catalog-dataset-count bootstrap "alpha")))
        (check (= 1 (catalog-dataset-count bootstrap "beta")))
        (let ((row (catalog-graph-row bootstrap "old")))
          (check (equal "Old Graph" (quasar.protocol:json-value row "name")))
          (check (= 2 (quasar.protocol:json-value row "nodeCount")))
          (check (= 0 (quasar.protocol:json-value row "edgeCount")))))
      ;; Migration is one-time: the marker now exists and a reopened store
      ;; serves the same catalog without rebuilding it.
      (let ((database (quasar.store::tek9-store-database store)))
        (check (quasar.store::%workspace-catalog-present-p database "legacy"))
        (quasar.store:close-store store)
        (setf store (quasar.store:make-tek9-store :path path))
        (let ((bootstrap (quasar.store:workspace-bootstrap store "legacy")))
          (check (= 2 (catalog-dataset-count bootstrap "alpha")))
          (check (= 1 (catalog-dataset-count bootstrap "beta"))))))))

(defun catalog-membership-request (graph-id &rest pairs)
  (apply #'quasar.protocol:json-object (cons "graphId" graph-id) pairs))

(defun test-graph-membership-paging ()
  "Membership pages node sidecars in bounded pages with exact cursors."
  (with-temporary-tek9-store (store path "catalog-membership")
    (let* ((count 120)
           (plane (quasar.control-plane:start-control-plane
                   (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (progn
             (dotimes (index count)
               (catalog-plane-command
                plane "document.create"
                (catalog-document (format nil "person:~3,'0D" index) "alpha")))
             (catalog-plane-command
              plane "graph.workspace.put"
              (quasar.protocol:json-object
               (cons "id" "case")
               (cons "name" "Case")
               (cons "documentIds"
                     (cons :array
                           (loop for index below count
                                 collect (format nil "person:~3,'0D" index))))
               (cons "nodes"
                     (cons :array
                           (loop for index below count
                                 collect (quasar.protocol:json-object
                                          (cons "id" (format nil "n~3,'0D" index))
                                          (cons "graphId" "case")
                                          (cons "documentId" (format nil "person:~3,'0D" index))))))))
             ;; Page through every member in bounded pages.
             (let ((seen 0) (cursor nil) (done nil) (pages 0))
               (loop until done
                     do (let* ((request (catalog-membership-request "case" (cons "limit" 50)))
                               (page (progn (when cursor
                                              (quasar.protocol:object-set request "cursor" cursor))
                                            (quasar.store:graph-membership store "default" request))))
                          (incf pages)
                          (check (string= "bounded-node-scan"
                                          (quasar.protocol:json-value
                                           (quasar.protocol:json-value page "performance") "mode")))
                          (incf seen
                                (length (array-elements-for-test
                                         (quasar.protocol:json-value page "documentIds"))))
                          (setf done (eq t (quasar.protocol:json-value page "complete"))
                                cursor (quasar.protocol:json-value page "cursor"))))
               (check (= count seen))
               (check (= 3 pages)))
             ;; One page can hold the full graph within the record budget.
             (let ((page (quasar.store:graph-membership
                          store "default" (catalog-membership-request "case" (cons "limit" 250)))))
               (check (eq t (quasar.protocol:json-value page "complete")))
               (check (= count (length (array-elements-for-test
                                        (quasar.protocol:json-value page "documentIds"))))))
             ;; Cursors bind workspace revision and graph identity.
             (let* ((request (catalog-membership-request "case" (cons "limit" 10)))
                    (page (quasar.store:graph-membership store "default" request))
                    (cursor (quasar.protocol:json-value page "cursor")))
               (catalog-plane-command plane "document.create" (catalog-document "person:200" "beta"))
               (check (bounded-error-p "query.stale-cursor"
                                       (lambda () (quasar.store:graph-membership
                                                   store "default"
                                                   (catalog-membership-request
                                                    "case" (cons "cursor" cursor))))))
               (let* ((fresh (quasar.store:graph-membership
                              store "default" (catalog-membership-request "case" (cons "limit" 10))))
                      (fresh-cursor (quasar.protocol:json-value fresh "cursor"))
                      (wrong-graph (quasar.store::%membership-cursor
                                    "default"
                                    (quasar.protocol:json-value fresh "revision")
                                    "other" "quasar/v1/ws/8:default/node/4:case/4:n001")))
                 (declare (ignore fresh-cursor))
                 (check (bounded-error-p "query.invalid-cursor"
                                         (lambda () (quasar.store:graph-membership
                                                     store "default"
                                                     (catalog-membership-request
                                                      "case" (cons "cursor" wrong-graph))))))))
             (check (bounded-error-p "graph.not-found"
                                     (lambda () (quasar.store:graph-membership
                                                 store "default"
                                                 (catalog-membership-request "absent")))))
             (check (bounded-error-p "query.invalid"
                                     (lambda () (quasar.store:graph-membership
                                                 store "default"
                                                 (quasar.protocol:json-object
                                                  (cons "graphId" "case")
                                                  (cons "limit" 251)))))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-catalog-pages-are-bounded-reads ()
  "Catalog pages and membership never hydrate the workspace."
  (with-temporary-tek9-store (store path "catalog-instrumented")
    (let ((plane (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (progn
             (catalog-plane-command plane "document.create" (catalog-document "person:1" "alpha"))
             (catalog-plane-command plane "graph.workspace.put"
                                    (quasar.protocol:json-object
                                     (cons "id" "case") (cons "name" "Case")
                                     (cons "documentIds" (quasar.protocol:json-array "person:1"))
                                     (cons "nodes"
                                           (quasar.protocol:json-array
                                            (quasar.protocol:json-object
                                             (cons "id" "n1") (cons "graphId" "case")
                                             (cons "documentId" "person:1")))))))
        (quasar.control-plane:stop-control-plane plane)))
    (with-bounded-read-instrumentation
     (lambda ()
       (let ((bootstrap (quasar.store:workspace-bootstrap store "default")))
         (check (= 1 (catalog-dataset-count bootstrap "alpha")))
         (check (catalog-graph-row bootstrap "case")))
       (let ((page (quasar.store:graph-membership
                    store "default" (catalog-membership-request "case"))))
         (check (equal '("person:1")
                       (array-elements-for-test
                        (quasar.protocol:json-value page "documentIds")))))))))

(defun run-catalog-tests ()
  (let ((*failures* 0))
    (test-catalog-maintenance-through-commits)
    (test-catalog-legacy-migration)
    (test-graph-membership-paging)
    (test-catalog-pages-are-bounded-reads)
    (when (plusp *failures*) (error "~D catalog test checks failed." *failures*))
    t))
