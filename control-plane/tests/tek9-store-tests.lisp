(in-package #:quasar.tests)

(defun unique-tek9-test-path (name)
  (merge-pathnames
   (format nil "quasar-tek9-tests/~A-~36R/"
           name
           (random most-positive-fixnum))
   (uiop:temporary-directory)))

(defmacro with-temporary-tek9-store ((store path name) &body body)
  `(let* ((,path (unique-tek9-test-path ,name))
          (,store nil))
     (unwind-protect
          (progn
            (setf ,store (quasar.store:make-tek9-store :path ,path))
            ,@body)
       (when ,store
         (ignore-errors (quasar.store:close-store ,store)))
       (when (probe-file ,path)
         (uiop:delete-directory-tree
          ,path :validate t :if-does-not-exist :ignore)))))

(defun tek9-command-ok-p (plane command payload &key id (workspace "default"))
  (string= "ok"
           (status
            (call-command
             plane
             (make-envelope command payload
                            :id (or id (format nil "~A-test" command))
                            :workspace workspace)))))

(defun graph-payload-for-restart-test ()
  (quasar.protocol:json-object
   (cons "id" "case")
   (cons "name" "Case Graph")
   (cons "documentIds"
         (quasar.protocol:json-array "person:1" "relation:1"))
   (cons "positions"
         (quasar.protocol:json-object
          (cons "n1"
                (quasar.protocol:json-object (cons "x" 11) (cons "y" 22)))
          (cons "n2"
                (quasar.protocol:json-object (cons "x" 33) (cons "y" 44)))))
   (cons "viewport"
         (quasar.protocol:json-object (cons "zoom" 1.25) (cons "panX" 7)))
   (cons "layout" "preset")
   (cons "groups"
         (quasar.protocol:json-array
          (quasar.protocol:json-object (cons "id" "g1") (cons "name" "People"))))
   (cons "nodes"
         (quasar.protocol:json-array
          (quasar.protocol:json-object
           (cons "id" "n1")
           (cons "graphId" "case")
           (cons "documentId" "person:1"))
          (quasar.protocol:json-object
           (cons "id" "n2")
           (cons "graphId" "case")
           (cons "documentId" "relation:1"))))
   (cons "edges"
         (quasar.protocol:json-array
          (quasar.protocol:json-object
           (cons "id" "edge:1")
           (cons "graphId" "case")
           (cons "source" "n1")
           (cons "target" "n2")
           (cons "predicate" "relates-to")
           (cons "documentId" "relation:1")
           (cons "label" "canonical edge metadata"))))))

(defun restart-transaction-payload ()
  (quasar.protocol:json-object
   (cons "expectedRevision" 3)
   (cons "operations"
         (quasar.protocol:json-array
          (quasar.protocol:json-object
           (cons "type" "document.create")
           (cons "payload" (make-doc "person:2" "person")))
          (quasar.protocol:json-object
           (cons "type" "graph.node.create")
           (cons "payload"
                 (quasar.protocol:json-object
                  (cons "graphId" "case")
                  (cons "id" "n3")
                  (cons "documentId" "person:2"))))
          (quasar.protocol:json-object
           (cons "type" "graph.edge.create")
           (cons "payload"
                 (quasar.protocol:json-object
                  (cons "graphId" "case")
                  (cons "id" "edge:2")
                  (cons "source" "n2")
                  (cons "target" "n3")
                  (cons "predicate" "supports"))))))))

(defun test-tek9-default-and-configured-path ()
  (let ((default (namestring (quasar.store:default-tek9-path))))
    (check (search "/quasar/tek9/" default :from-end t)))
  (with-temporary-tek9-store (store path "configured-path")
    (check (equal (truename path)
                  (truename (quasar.store:tek9-store-path store))))))

(defun seed-restart-workspace (plane)
  (check (tek9-command-ok-p plane
                            "document.create"
                            (make-doc "person:1" "person")
                            :id "restart-person"))
  (check (tek9-command-ok-p plane
                            "document.create"
                            (make-doc "relation:1" "relation")
                            :id "restart-relation"))
  (check (tek9-command-ok-p plane
                            "graph.workspace.put"
                            (graph-payload-for-restart-test)
                            :id "restart-graph"))
  (check (tek9-command-ok-p plane
                            "workspace.transaction"
                            (restart-transaction-payload)
                            :id "restart-transaction"))
  (check (tek9-command-ok-p
          plane
          "graph.workspace.activate"
          (quasar.protocol:json-object (cons "id" "case"))
          :id "restart-active")))

(defun assert-restarted-workspace (store plane expected-revision)
  (let* ((response
           (call-command
            plane
            (make-envelope "workspace.snapshot"
                           (quasar.protocol:empty-object)
                           :id "restart-snapshot")))
         (snapshot (result response))
         (workspace
           (gethash "default"
                    (quasar.control-plane:control-plane-workspaces plane)))
         (graph (workspace-graph workspace "case")))
    (check (string= "ok" (status response)))
    (check (= expected-revision (workspace-revision workspace)))
    (check (gethash "person:1" (workspace-documents workspace)))
    (check (string= "relation"
                    (quasar.protocol:json-value
                     (gethash "relation:1" (workspace-documents workspace))
                     "dtype")))
    (check (gethash "person:2" (workspace-documents workspace)))
    (check graph)
    (check (graph-node graph "n1"))
    (check (graph-node graph "n3"))
    (check (graph-edge graph "edge:1"))
    (check (graph-edge graph "edge:2"))
    (check (string= "canonical edge metadata"
                    (quasar.protocol:json-value
                     (graph-edge graph "edge:1") "label")))
    (check (string= "relation:1"
                    (quasar.protocol:json-value
                     (graph-edge graph "edge:1") "documentId")))
    (check (equal "preset" (quasar.protocol:json-value graph "layout")))
    (check (quasar.protocol:json-value graph "viewport"))
    (check (quasar.protocol:json-value graph "positions"))
    (check (quasar.protocol:json-value graph "groups"))
    (check (string= "case"
                    (gethash "activeGraphId" (workspace-settings workspace))))
    (check (= expected-revision
              (length (quasar.store:store-journal-entries store "default"))))
    (check snapshot)))

(defun test-tek9-restart-restores-canonical-workspace ()
  (let* ((path (unique-tek9-test-path "restart"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (progn
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1 (quasar.control-plane:make-control-plane :store store-1))
           (quasar.control-plane:start-control-plane plane-1)
           (seed-restart-workspace plane-1)
           (let ((revision
                   (quasar.store:direct-workspace-revision store-1 "default")))
             (check (= 5 revision))
             (check (= 0
                       (hash-table-count
                        (quasar.control-plane:control-plane-workspaces plane-1))))
             (quasar.control-plane:stop-control-plane plane-1)
             (setf plane-1 nil)
             (quasar.store:close-store store-1)
             (setf store-1 nil)
             (setf store-2 (quasar.store:make-tek9-store :path path)
                   plane-2 (quasar.control-plane:make-control-plane :store store-2))
             (quasar.control-plane:start-control-plane plane-2)
             (assert-restarted-workspace store-2 plane-2 revision)))
      (when plane-1
        (ignore-errors (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))

(defun test-tek9-workspace-namespaces-isolate-identical-ids ()
  (with-temporary-tek9-store (store path "namespace")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (dolist (workspace-id '("alpha" "beta"))
               (check
                (tek9-command-ok-p
                 plane
                 "document.create"
                 (quasar.protocol:json-object
                  (cons "_id" "same")
                  (cons "dtype" "person")
                  (cons "workspaceValue" workspace-id))
                 :id (format nil "create-~A" workspace-id)
                 :workspace workspace-id)))
             (let ((alpha (quasar.store:load-workspace store "alpha"))
                   (beta (quasar.store:load-workspace store "beta")))
               (check (string= "alpha"
                               (quasar.protocol:json-value
                                (gethash "same" (workspace-documents alpha))
                                "workspaceValue")))
               (check (string= "beta"
                               (quasar.protocol:json-value
                                (gethash "same" (workspace-documents beta))
                                "workspaceValue")))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun failing-mixed-transaction-payload (base-revision)
  (quasar.protocol:json-object
   (cons "expectedRevision" base-revision)
   (cons "operations"
         (quasar.protocol:json-array
          (quasar.protocol:json-object
           (cons "type" "document.create")
           (cons "payload" (make-doc "candidate" "person")))
          (quasar.protocol:json-object
           (cons "type" "graph.node.create")
           (cons "payload"
                 (quasar.protocol:json-object
                  (cons "graphId" "g")
                  (cons "id" "candidate-node")
                  (cons "documentId" "candidate"))))))))

(defun test-tek9-mixed-domain-failure-is-atomic-and-silent ()
  (with-temporary-tek9-store (store path "atomic-failure")
    (let* ((plane (quasar.control-plane:make-control-plane :store store))
           (*events-box* (list nil)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (quasar.control-plane:subscribe plane (event-collector))
             (check (tek9-command-ok-p plane
                                       "document.create"
                                       (make-doc "base" "person")
                                       :id "base-create"))
             (check
              (tek9-command-ok-p
               plane
               "graph.workspace.put"
               (quasar.protocol:json-object
                (cons "id" "g")
                (cons "name" "G")
                (cons "documentIds" (quasar.protocol:json-array "base")))
               :id "base-graph"))
             (let* ((base-revision
                      (quasar.store:direct-workspace-revision store "default"))
                    (event-count (length (car *events-box*))))
               (check (= 0
                         (hash-table-count
                          (quasar.control-plane:control-plane-workspaces plane))))
               (setf (quasar.store:tek9-store-failure-hook store)
                     (lambda (stage)
                       (when (eq stage :before-commit)
                         (error "injected Tek9 commit failure"))))
               (let ((response
                       (call-command
                        plane
                        (make-envelope
                         "workspace.transaction"
                         (failing-mixed-transaction-payload base-revision)
                         :id "failing-transaction"))))
                 (check (string= "error" (status response))))
               (check (= base-revision
                         (quasar.store:direct-workspace-revision store "default")))
               (check (null
                       (quasar.store:direct-document
                        store "default" "candidate")))
               (check (= 0
                         (hash-table-count
                          (quasar.control-plane:control-plane-workspaces plane))))
               (check (= event-count (length (car *events-box*))))
               (setf (quasar.store:tek9-store-failure-hook store) nil)
               (quasar.store:close-store store)
               (setf store (quasar.store:make-tek9-store :path path))
               (let ((reopened (quasar.store:load-workspace store "default")))
                 (check (= base-revision (workspace-revision reopened)))
                 (check (null (gethash "candidate"
                                       (workspace-documents reopened))))
                 (check (null (graph-node (workspace-graph reopened "g")
                                          "candidate-node")))
                 (check (= base-revision
                           (length
                            (quasar.store:store-journal-entries
                             store "default")))))))
        (ignore-errors (quasar.control-plane:stop-control-plane plane))))))

(defun bulk-seed-operations (count)
  (apply #'quasar.protocol:json-array
         (loop for n below count
               collect
               (quasar.protocol:json-object
                (cons "type" "document.create")
                (cons "payload"
                      (quasar.protocol:json-object
                       (cons "_id" (format nil "doc:~D" n))
                       (cons "dtype" "person")))))))

(defun test-tek9-single-record-update-does-not-rewrite-corpus ()
  (with-temporary-tek9-store (store path "bounded-write")
    (let ((plane (quasar.control-plane:make-control-plane :store store)))
      (unwind-protect
           (progn
             (quasar.control-plane:start-control-plane plane)
             (check
              (tek9-command-ok-p
               plane
               "workspace.transaction"
               (quasar.protocol:json-object
                (cons "expectedRevision" 0)
                (cons "operations" (bulk-seed-operations 40)))
               :id "bulk-seed"))
             (check
              (tek9-command-ok-p
               plane
               "document.update"
               (quasar.protocol:json-object
                (cons "_id" "doc:17")
                (cons "dtype" "person")
                (cons "updated" :true))
               :id "single-update"))
             (let ((stats (quasar.store:tek9-store-last-commit-stats store)))
               (check (= 1 (getf stats :document-upserts)))
               (check (= 0 (getf stats :document-deletes)))
               (check (= 0 (getf stats :graph-replacements)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-tek9-store-tests ()
  (test-tek9-default-and-configured-path)
  (test-tek9-restart-restores-canonical-workspace)
  (test-tek9-workspace-namespaces-isolate-identical-ids)
  (test-tek9-mixed-domain-failure-is-atomic-and-silent)
  (test-tek9-single-record-update-does-not-rewrite-corpus)
  t)
