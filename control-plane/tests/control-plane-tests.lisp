(in-package #:quasar.tests)

(defvar *failures* 0)
(defvar *events-box* nil)

(defclass failing-store (quasar.store:workspace-store) ())

(defmethod quasar.store:load-workspace ((store failing-store) workspace-id)
  (declare (ignore store workspace-id))
  nil)

(defmethod quasar.store:save-workspace ((store failing-store) workspace)
  (declare (ignore store workspace))
  (error "injected persistence failure"))

(defmethod quasar.store:append-operation ((store failing-store) workspace-id operation)
  (declare (ignore store workspace-id operation))
  (error "injected persistence failure"))

(defmethod quasar.store:commit-workspace ((store failing-store) workspace operation)
  (declare (ignore store workspace operation))
  (error "injected persistence failure"))

(defmacro check (form)
  `(unless ,form
     (incf *failures*)
     (format *error-output* "~&FAIL: ~S~%" ',form)))

(defun event-collector ()
  (lambda (encoded)
    (push encoded (car *events-box*))))

(defun make-envelope (command payload &key (id "test-1") (workspace "default"))
  (quasar.protocol:encode
   (quasar.protocol:json-object
    (cons "protocol" quasar.protocol:+protocol-version+)
    (cons "id" id)
    (cons "command" command)
    (cons "payload" payload)
    (cons "metadata"
          (quasar.protocol:json-object
           (cons "client" "quasar-tests")
           (cons "workspace" workspace))))))

(defun call-command (plane encoded)
  (let (response)
    (quasar.control-plane:submit-command
     plane
     encoded
     (lambda (r) (setf response r)))
    (loop until response
          for i below 1000
          do (sleep 0.01)
          finally (return response))))

(defun parsed (response)
  (jsown:parse response))

(defun status (response)
  (jsown:val (parsed response) "status"))

(defun result (response)
  (jsown:val (parsed response) "result"))

(defun error-code (response)
  (jsown:val (jsown:val (parsed response) "error") "code"))

(defun make-doc (id &optional (dtype "person"))
  (quasar.protocol:json-object
   (cons "_id" id)
   (cons "dtype" dtype)))

(defun make-node (graph-id node-id &optional document-id)
  (let ((node (quasar.protocol:json-object
               (cons "graphId" graph-id)
               (cons "id" node-id))))
    (when document-id
      (quasar.protocol:object-set node "documentId" document-id))
    node))

(defun make-edge (graph-id edge-id source target)
  (quasar.protocol:json-object
   (cons "graphId" graph-id)
   (cons "id" edge-id)
   (cons "source" source)
   (cons "target" target)))

(defun array-elements-for-test (value)
  (if (and (consp value) (eq (car value) :array)) (rest value) value))

;;; --- Protocol tests ---

(defun test-protocol-decode ()
  (let* ((envelope (quasar.protocol:decode-command
                     (make-envelope "document.list" (quasar.protocol:empty-object)))))
    (check (string= (quasar.protocol:command-envelope-id envelope) "test-1"))
    (check (string= (quasar.protocol:command-envelope-command envelope) "document.list")))
  (handler-case
      (quasar.protocol:decode-command
       (quasar.protocol:encode
        (quasar.protocol:json-object
         (cons "protocol" "quasar.control.v9")
         (cons "id" "x")
         (cons "command" "ping")
         (cons "payload" (quasar.protocol:empty-object)))))
    (quasar.protocol:quasar-error (c)
      (check (string= (quasar.protocol:quasar-error-code c)
                     "protocol.invalid-envelope")))
    (:no-error (&rest args)
      (declare (ignore args))
      (incf *failures*)
      (format *error-output* "~&FAIL: bad protocol did not signal~%")))
  (handler-case
      (quasar.protocol:decode-command "not json at all")
    (quasar.protocol:quasar-error (c)
      (check (string= (quasar.protocol:quasar-error-code c)
                     "protocol.invalid-envelope")))
    (:no-error (&rest args)
      (declare (ignore args))
      (incf *failures*)
      (format *error-output* "~&FAIL: malformed envelope did not signal~%"))))

(defun test-protocol-encode ()
  (check (search "\"status\":\"ok\""
                 (quasar.protocol:encode-result
                  "1" (quasar.protocol:json-object))))
  (check (search "\"status\":\"error\""
                 (quasar.protocol:encode-error
                  "1" "workspace.not-found" "nope"))))

(defun test-clone-json ()
  (let* ((original (quasar.protocol:json-object
                    (cons "nodes" (quasar.protocol:json-array
                                   (quasar.protocol:json-object
                                    (cons "id" "n1")
                                    (cons "position" (quasar.protocol:json-object
                                                       (cons "x" 10) (cons "y" 20))))))))
         (clone (quasar.protocol:clone-json original)))
    (check (eq (quasar.protocol:object-p clone) t))
    (let ((orig-node (first (rest (quasar.protocol:json-value original "nodes"))))
          (clone-node (first (rest (quasar.protocol:json-value clone "nodes")))))
      (check (not (eq orig-node clone-node)))
      (check (not (eq (quasar.protocol:json-value orig-node "position")
                      (quasar.protocol:json-value clone-node "position"))))))
  (let* ((parsed (jsown:parse "{\"items\":[{\"id\":\"first\"},{\"id\":\"second\"}]}"))
         (clone (quasar.protocol:clone-json parsed))
         (items (quasar.protocol:json-value clone "items")))
    (check (= 2 (length items)))
    (check (string= "first" (quasar.protocol:json-value (first items) "id")))
    (check (not (eq (first items)
                    (first (quasar.protocol:json-value parsed "items")))))))

;;; --- Workspace tests ---

(defun test-workspace-revision ()
  (let ((workspace (make-workspace :id "rev-test")))
    (check (= 0 (workspace-revision workspace)))
    (quasar.workspace:dispatch-operation
     workspace
     (quasar.protocol:json-object
      (cons "type" "document.create")
      (cons "payload" (make-doc "person:1"))))
    (check (= 0 (workspace-revision workspace)))))

;;; --- Document CRUD ---

(defun test-document-crud ()
  (let ((workspace (make-workspace :id "crud-test")))
    (quasar.workspace:apply-document-create
     workspace (make-doc "person:crud"))
    (check (gethash "person:crud" (workspace-documents workspace)))
    (let ((applied (quasar.workspace:apply-document-update
                    workspace (quasar.protocol:json-object
                               (cons "_id" "person:crud")
                               (cons "dtype" "person")
                               (cons "data" (quasar.protocol:json-object (cons "note" "updated")))))))
      (check (string= "updated"
                      (jsown:val
                       (jsown:val
                        (gethash "person:crud" (workspace-documents workspace))
                        "data")
                       "note")))
      (check (quasar.protocol:json-value (applied-op-result applied) "previous")))
    (let ((applied (quasar.workspace:apply-document-delete
                    workspace (quasar.protocol:json-object (cons "id" "person:crud")))))
      (check (null (gethash "person:crud" (workspace-documents workspace))))
      (check (quasar.protocol:json-value (applied-op-result applied) "previous")))))

(defun test-document-not-found ()
  (let ((workspace (make-workspace :id "nf-test")))
    (handler-case
        (quasar.workspace:apply-document-delete
         workspace (quasar.protocol:json-object (cons "id" "nope")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "document.not-found")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: missing delete did not signal~%")))))

(defun test-document-invalid ()
  (let ((workspace (make-workspace :id "inv-test")))
    (let* ((applied (quasar.workspace:apply-document-create
                     workspace (quasar.protocol:json-object (cons "dtype" "person"))))
           (created (quasar.protocol:json-value (applied-op-result applied) "created")))
      (check (quasar.protocol:json-value created "_id")))
    (handler-case
        (quasar.workspace:apply-document-create
         workspace (quasar.protocol:json-object (cons "_id" "x")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "document.invalid")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: missing dtype did not signal~%")))))

;;; --- Graph node CRUD ---

(defun test-node-crud ()
  (let ((workspace (make-workspace :id "node-test")))
    (quasar.workspace:apply-document-create workspace (make-doc "person:1"))
    (quasar.workspace:apply-node-create
     workspace (make-node "g1" "node-1" "person:1"))
    (let ((graph (workspace-graph workspace "g1")))
      (check graph)
      (check (graph-node graph "node-1")))
    (let ((applied (quasar.workspace:apply-node-update
                    workspace (make-node "g1" "node-1" "person:1"))))
      (quasar.protocol:object-set (quasar.protocol:json-value (applied-op-result applied) "updated")
                                   "position" (quasar.protocol:json-object (cons "x" 10) (cons "y" 20))))
    (let ((applied (quasar.workspace:apply-node-delete
                    workspace (make-node "g1" "node-1"))))
      (check (null (graph-node (workspace-graph workspace "g1") "node-1")))
      (check (quasar.protocol:json-value (applied-op-result applied) "previous")))))

(defun test-node-not-found ()
  (let ((workspace (make-workspace :id "nnf-test")))
    (handler-case
        (quasar.workspace:apply-node-delete
         workspace (make-node "g1" "ghost"))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "graph.not-found")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: missing node delete did not signal~%")))))

(defun test-node-invalid-document-ref ()
  (let ((workspace (make-workspace :id "nir-test")))
    (handler-case
        (quasar.workspace:apply-node-create
         workspace (make-node "g1" "n1" "nonexistent:doc"))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "graph.invalid-reference")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: node ref to missing doc did not signal~%")))))

;;; --- Graph edge CRUD ---

(defun test-edge-crud ()
  (let ((workspace (make-workspace :id "edge-test")))
    (quasar.workspace:apply-node-create workspace (make-node "ge" "a"))
    (quasar.workspace:apply-node-create workspace (make-node "ge" "b"))
    (let ((applied (quasar.workspace:apply-edge-create
                    workspace (make-edge "ge" "e1" "a" "b"))))
      (check (graph-edge (workspace-graph workspace "ge") "e1"))
      (check (quasar.protocol:json-value (applied-op-result applied) "created")))
    (let ((applied (quasar.workspace:apply-edge-delete
                    workspace (make-edge "ge" "e1" "a" "b"))))
      (check (null (graph-edge (workspace-graph workspace "ge") "e1")))
      (check (quasar.protocol:json-value (applied-op-result applied) "previous")))))

(defun test-edge-invalid-reference ()
  (let ((workspace (make-workspace :id "eir-test")))
    (quasar.workspace:apply-node-create workspace (make-node "gir" "a"))
    (handler-case
        (quasar.workspace:apply-edge-create
         workspace (make-edge "gir" "bad" "a" "nonexistent"))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "graph.invalid-reference")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: bad edge ref did not signal~%")))))

;;; --- Node deletion removes dangling edges ---

(defun test-node-delete-removes-edges ()
  (let ((workspace (make-workspace :id "nde-test")))
    (quasar.workspace:apply-node-create workspace (make-node "g" "a"))
    (quasar.workspace:apply-node-create workspace (make-node "g" "b"))
    (quasar.workspace:apply-edge-create workspace (make-edge "g" "e1" "a" "b"))
    (quasar.workspace:apply-edge-create workspace (make-edge "g" "e2" "b" "a"))
    (let ((applied (quasar.workspace:apply-node-delete workspace (make-node "g" "a"))))
      (check (null (graph-node (workspace-graph workspace "g") "a")))
      (check (null (graph-edge (workspace-graph workspace "g") "e1")))
      (check (null (graph-edge (workspace-graph workspace "g") "e2")))
      (let ((removed (quasar.protocol:json-value (applied-op-result applied) "removedEdges")))
        (check (= 2 (length (rest removed))))))))

;;; --- Document deletion blocked when referenced by graph ---

(defun test-document-delete-blocked-by-graph ()
  (let ((workspace (make-workspace :id "ddb-test")))
    (quasar.workspace:apply-document-create workspace (make-doc "person:ref"))
    (quasar.workspace:apply-node-create workspace (make-node "g" "n1" "person:ref"))
    (handler-case
        (quasar.workspace:apply-document-delete
         workspace (quasar.protocol:json-object (cons "id" "person:ref")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "graph.invalid-reference")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: doc delete with graph ref did not signal~%")))
    (check (gethash "person:ref" (workspace-documents workspace)))))

;;; --- Duplicate ID rejection ---

(defun test-duplicate-id-rejection ()
  (let ((workspace (make-workspace :id "dup-test")))
    (quasar.workspace:apply-document-create workspace (make-doc "person:dup"))
    (handler-case
        (quasar.workspace:apply-document-create workspace (make-doc "person:dup"))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "document.duplicate-id")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: duplicate doc did not signal~%")))
    (quasar.workspace:apply-node-create workspace (make-node "g" "n1"))
    (handler-case
        (quasar.workspace:apply-node-create workspace (make-node "g" "n1"))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "graph.duplicate-id")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: duplicate node did not signal~%")))))

;;; --- Transaction rollback ---

(defun test-transaction-rollback ()
  (let ((workspace (make-workspace :id "tx-test")))
    (quasar.workspace:apply-document-create workspace (make-doc "existing:1"))
    (let ((candidate (make-workspace :id "tx-test")))
      (copy-workspace-state-for-test workspace candidate)
      (handler-case
          (quasar.workspace:commit-operations
           candidate
           (list
            (quasar.protocol:json-object
             (cons "type" "document.create")
             (cons "payload" (make-doc "tx-new")))
            (quasar.protocol:json-object
             (cons "type" "document.create")
             (cons "payload" (make-doc "tx-new")))))
        (quasar.protocol:quasar-error (c)
          (check (string= (quasar.protocol:quasar-error-code c) "document.duplicate-id")))
        (:no-error (&rest args)
          (declare (ignore args))
          (incf *failures*)
          (format *error-output* "~&FAIL: dup in tx did not signal~%")))
      (check (null (gethash "tx-new" (workspace-documents workspace))))
      (check (gethash "existing:1" (workspace-documents workspace))))))

(defun copy-workspace-state-for-test (source target)
  "Same as control-plane's copy-workspace-state, but callable from tests."
  (setf (workspace-revision target) (workspace-revision source))
  (clrhash (workspace-documents target))
  (clrhash (workspace-graphs target))
  (clrhash (workspace-settings target))
  (loop for key being the hash-keys of (workspace-documents source)
        using (hash-value value)
        do (setf (gethash key (workspace-documents target))
                 (quasar.protocol:clone-json value)))
  (loop for key being the hash-keys of (workspace-graphs source)
        using (hash-value value)
        do (setf (gethash key (workspace-graphs target))
                 (quasar.protocol:clone-json value)))
  (loop for key being the hash-keys of (workspace-settings source)
        using (hash-value value)
        do (setf (gethash key (workspace-settings target))
                 (quasar.protocol:clone-json value))))

;;; --- Transaction isolation: graph deep copy ---

(defun test-transaction-graph-isolation ()
  (let ((workspace (make-workspace :id "tx-graph-test")))
    (quasar.workspace:apply-node-create workspace (make-node "g" "a"))
    (quasar.workspace:apply-node-create workspace (make-node "g" "b"))
    (quasar.workspace:apply-edge-create workspace (make-edge "g" "e1" "a" "b"))
    (let ((candidate (make-workspace :id "tx-graph-test")))
      (copy-workspace-state-for-test workspace candidate)
      (handler-case
          (quasar.workspace:commit-operations
           candidate
           (list (quasar.protocol:json-object
                  (cons "type" "graph.node.create")
                  (cons "payload" (make-node "g" "c")))))
        (error ()
          (incf *failures*)
          (format *error-output* "~&FAIL: valid graph txn should not signal~%")))
      (let ((orig-graph (workspace-graph workspace "g"))
            (cand-graph (workspace-graph candidate "g")))
        (check (not (eq orig-graph cand-graph)))
        (check (not (eq (quasar.protocol:json-value orig-graph "nodes")
                        (quasar.protocol:json-value cand-graph "nodes"))))
        (check (= 2 (length (rest (quasar.protocol:json-value orig-graph "nodes")))))
        (check (= 3 (length (rest (quasar.protocol:json-value cand-graph "nodes")))))
        (check (= 1 (length (rest (quasar.protocol:json-value orig-graph "edges")))))
        (check (= 1 (length (rest (quasar.protocol:json-value cand-graph "edges")))))))))

;;; --- Transaction rollback: graph unchanged after failure ---

(defun test-transaction-graph-rollback ()
  (let ((workspace (make-workspace :id "tx-gr-test")))
    (quasar.workspace:apply-node-create workspace (make-node "g" "a"))
    (quasar.workspace:apply-node-create workspace (make-node "g" "b"))
    (quasar.workspace:apply-edge-create workspace (make-edge "g" "e1" "a" "b"))
    (let ((orig-nodes-json (quasar.protocol:encode
                            (quasar.protocol:json-value
                             (workspace-graph workspace "g") "nodes")))
          (orig-edges-json (quasar.protocol:encode
                            (quasar.protocol:json-value
                             (workspace-graph workspace "g") "edges")))
          (orig-revision (workspace-revision workspace)))
      (let ((candidate (make-workspace :id "tx-gr-test")))
        (copy-workspace-state-for-test workspace candidate)
        (handler-case
            (quasar.workspace:commit-operations
             candidate
             (list
              (quasar.protocol:json-object
               (cons "type" "graph.node.create")
               (cons "payload" (make-node "g" "c")))
              (quasar.protocol:json-object
               (cons "type" "graph.node.delete")
               (cons "payload" (make-node "g" "nonexistent")))))
          (quasar.protocol:quasar-error ()
            nil)
          (:no-error (&rest args)
            (declare (ignore args))
            (incf *failures*)
            (format *error-output* "~&FAIL: tx with bad node delete should signal~%"))))
      (check (string= orig-nodes-json
                      (quasar.protocol:encode
                       (quasar.protocol:json-value
                        (workspace-graph workspace "g") "nodes"))))
      (check (string= orig-edges-json
                      (quasar.protocol:encode
                       (quasar.protocol:json-value
                        (workspace-graph workspace "g") "edges"))))
      (check (= orig-revision (workspace-revision workspace))))))

;;; --- Inverse round-trip tests ---

(defun test-inverse-round-trip-document ()
  (let ((workspace (make-workspace :id "inv-doc-test")))
    (let ((applied (quasar.workspace:apply-document-create
                    workspace (make-doc "person:rt"))))
      (check (gethash "person:rt" (workspace-documents workspace)))
      (let ((inverse (applied-op-inverse applied)))
        (quasar.workspace:dispatch-operation workspace inverse))
      (check (null (gethash "person:rt" (workspace-documents workspace)))))))

(defun test-inverse-round-trip-node ()
  (let ((workspace (make-workspace :id "inv-node-test")))
    (let ((applied (quasar.workspace:apply-node-create
                    workspace (make-node "g" "n1"))))
      (let ((inverse (applied-op-inverse applied)))
        (quasar.workspace:dispatch-operation workspace inverse))
      (check (null (graph-node (workspace-graph workspace "g") "n1"))))))

(defun test-node-delete-inverse-restores-edges ()
  (let ((workspace (make-workspace :id "inv-node-edges")))
    (quasar.workspace:apply-node-create workspace (make-node "g" "a"))
    (quasar.workspace:apply-node-create workspace (make-node "g" "b"))
    (quasar.workspace:apply-edge-create workspace (make-edge "g" "e1" "a" "b"))
    (let ((applied (quasar.workspace:apply-node-delete workspace (make-node "g" "a"))))
      (quasar.workspace:dispatch-operation workspace (applied-op-inverse applied))
      (check (graph-node (workspace-graph workspace "g") "a"))
      (check (graph-edge (workspace-graph workspace "g") "e1")))))

(defun test-document-delete-membership-inverse ()
  (let ((workspace (make-workspace :id "inv-membership")))
    (quasar.workspace:apply-document-create workspace (make-doc "person:member"))
    (quasar.workspace:apply-graph-put
     workspace
     (quasar.protocol:json-object
      (cons "id" "case")
      (cons "name" "Case")
      (cons "documentIds" (quasar.protocol:json-array "person:member"))))
    (let ((applied (quasar.workspace:apply-document-delete
                    workspace
                    (quasar.protocol:json-object (cons "id" "person:member")))))
      (check (null (array-elements-for-test
                    (quasar.protocol:json-value
                     (workspace-graph workspace "case") "documentIds"))))
      (quasar.workspace:dispatch-operation workspace (applied-op-inverse applied))
      (check (gethash "person:member" (workspace-documents workspace)))
      (check (member "person:member"
                     (array-elements-for-test
                      (quasar.protocol:json-value
                       (workspace-graph workspace "case") "documentIds"))
                     :test #'string=)))))

(defun test-inverse-round-trip-edge ()
  (let ((workspace (make-workspace :id "inv-edge-test")))
    (quasar.workspace:apply-node-create workspace (make-node "g" "a"))
    (quasar.workspace:apply-node-create workspace (make-node "g" "b"))
    (let ((applied (quasar.workspace:apply-edge-create
                    workspace (make-edge "g" "e1" "a" "b"))))
      (let ((inverse (applied-op-inverse applied)))
        (quasar.workspace:dispatch-operation workspace inverse))
      (check (null (graph-edge (workspace-graph workspace "g") "e1"))))))

(defun test-inverse-round-trip-update ()
  (let ((workspace (make-workspace :id "inv-upd-test")))
    (let ((original (make-doc "person:upd")))
      (quasar.workspace:apply-document-create workspace original)
      (let ((updated (quasar.protocol:json-object
                      (cons "_id" "person:upd")
                      (cons "dtype" "person")
                      (cons "data" (quasar.protocol:json-object (cons "note" "changed"))))))
        (let ((applied (quasar.workspace:apply-document-update workspace updated)))
          (let ((inverse (applied-op-inverse applied)))
            (quasar.workspace:dispatch-operation workspace inverse))
          (check (null (quasar.protocol:json-value
                        (gethash "person:upd" (workspace-documents workspace))
                        "data"))))))))

;;; --- Persistence / store tests ---

(defun test-store-roundtrip ()
  (let ((store (quasar.store:make-memory-store))
        (workspace (make-workspace :id "store-test")))
    (quasar.workspace:apply-document-create workspace (make-doc "person:store"))
    (quasar.store:save-workspace store workspace)
    (let ((loaded (quasar.store:load-workspace store "store-test")))
      (check loaded)
      (check (gethash "person:store" (workspace-documents loaded)))
      (quasar.protocol:object-set
       (gethash "person:store" (workspace-documents loaded)) "changed" t)
      (let ((reloaded (quasar.store:load-workspace store "store-test")))
        (check (null (quasar.protocol:json-value
                      (gethash "person:store" (workspace-documents reloaded))
                      "changed")))))))

(defun test-store-journal ()
  (let ((store (quasar.store:make-memory-store)))
    (quasar.store:append-operation store "ws-1"
                                   (quasar.protocol:json-object (cons "type" "document.create")))
    (quasar.store:append-operation store "ws-1"
                                   (quasar.protocol:json-object (cons "type" "document.delete")))
    (check (= 2 (length (quasar.store:store-journal-entries store "ws-1"))))))

(defun test-store-restart-restore ()
  (let* ((store (quasar.store:make-memory-store))
         (workspace (make-workspace :id "restart-test")))
    (quasar.workspace:apply-document-create workspace (make-doc "person:restart"))
    (quasar.store:save-workspace store workspace)
    (let ((loaded (quasar.store:load-workspace store "restart-test")))
      (check loaded)
      (check (gethash "person:restart" (workspace-documents loaded)))
      (quasar.store:save-workspace store loaded)
      (let ((reloaded (quasar.store:load-workspace store "restart-test")))
        (check (gethash "person:restart" (workspace-documents reloaded)))))))

;;; --- Control-plane persistence integration ---

(defun test-control-plane-persistence ()
  (let ((plane (make-control-plane)))
    (start-control-plane plane)
    (unwind-protect
         (progn
           (call-command
            plane
            (make-envelope "document.create"
                           (make-doc "person:persist")
                           :id "cp-1"))
           (sleep 0.1)
           (let ((loaded (quasar.store:load-workspace
                          (control-plane-store plane) "default")))
             (check loaded)
             (when loaded
               (check (gethash "person:persist"
                               (workspace-documents loaded))))))
      (stop-control-plane plane))))

(defun test-control-plane-restart-from-store ()
  (let* ((store (quasar.store:make-memory-store))
         (first (make-control-plane :store store)))
    (start-control-plane first)
    (unwind-protect
         (check (string= "ok"
                         (status (call-command
                                  first
                                  (make-envelope "document.create"
                                                 (make-doc "person:restart-plane"))))))
      (stop-control-plane first))
    (let ((second (make-control-plane :store store)))
      (start-control-plane second)
      (unwind-protect
           (let ((response (call-command
                            second
                            (make-envelope "workspace.snapshot"
                                           (quasar.protocol:empty-object)))))
             (check (string= "ok" (status response)))
             (check (search "person:restart-plane" response)))
        (stop-control-plane second)))))

(defun test-persistence-failure-does-not-commit ()
  (let ((plane (make-control-plane :store (make-instance 'failing-store))))
    (setf *events-box* (cons nil nil))
    (start-control-plane plane)
    (let ((sub-id (quasar.control-plane:subscribe plane (event-collector))))
      (unwind-protect
           (progn
             (check (string= "error"
                             (status (call-command
                                      plane
                                      (make-envelope "document.create"
                                                     (make-doc "person:must-not-commit"))))))
             (let ((snapshot (call-command
                              plane
                              (make-envelope "workspace.snapshot"
                                             (quasar.protocol:empty-object)))))
               (check (string= "ok" (status snapshot)))
               (check (null (search "person:must-not-commit" snapshot)))
               (check (= 0 (jsown:val (result snapshot) "revision"))))
             (check (null (car *events-box*))))
        (quasar.control-plane:unsubscribe plane sub-id)
        (stop-control-plane plane)))))

(defun test-failed-transaction-has-no-side-effects ()
  (let* ((store (quasar.store:make-memory-store))
         (plane (make-control-plane :store store)))
    (setf *events-box* (cons nil nil))
    (start-control-plane plane)
    (let ((sub-id (quasar.control-plane:subscribe plane (event-collector))))
      (unwind-protect
           (progn
             (call-command plane
                           (make-envelope "document.create" (make-doc "person:base")))
             (setf (car *events-box*) nil)
             (let ((before-journal
                     (length (quasar.store:store-journal-entries store "default")))
                   (response
                     (call-command
                      plane
                      (make-envelope
                       "workspace.transaction"
                       (quasar.protocol:json-object
                        (cons "operations"
                              (quasar.protocol:json-array
                               (quasar.protocol:json-object
                                (cons "type" "document.create")
                                (cons "payload" (make-doc "person:partial")))
                               (quasar.protocol:json-object
                                (cons "type" "document.create")
                                (cons "payload" (make-doc "person:base"))))))))))
               (check (string= "error" (status response)))
               (check (string= "transaction.failed" (error-code response)))
               (check (search "document.duplicate-id" response))
               (check (= before-journal
                         (length (quasar.store:store-journal-entries store "default"))))
               (check (null (car *events-box*))))
             (let ((snapshot (call-command plane
                                           (make-envelope "workspace.snapshot"
                                                          (quasar.protocol:empty-object)))))
               (check (= 1 (jsown:val (result snapshot) "revision")))
               (check (null (search "person:partial" snapshot)))))
        (quasar.control-plane:unsubscribe plane sub-id)
        (stop-control-plane plane)))))

;;; --- Transaction event sequencing ---

(defun test-transaction-event-sequencing ()
  (let ((plane (make-control-plane)))
    (setf *events-box* (cons nil nil))
    (start-control-plane plane)
    (let ((sub-id (quasar.control-plane:subscribe plane (event-collector))))
      (unwind-protect
           (let* ((tx-response
                    (call-command
                     plane
                     (make-envelope "workspace.transaction"
                                    (quasar.protocol:json-object
                                     (cons "operations"
                                           (quasar.protocol:json-array
                                            (quasar.protocol:json-object
                                             (cons "type" "document.create")
                                             (cons "payload" (make-doc "person:tx1")))
                                            (quasar.protocol:json-object
                                             (cons "type" "document.create")
                                             (cons "payload" (make-doc "person:tx2"))))))
                                    :id "tx-seq-1")))
                  (tx-status (status tx-response)))
             (check (string= tx-status "ok"))
             (sleep 0.5)
             (let ((events (reverse (car *events-box*))))
               (check (= (length events) 2))
               (when (= (length events) 2)
                 (let* ((parsed-events (mapcar #'jsown:parse events))
                        (txn-ids (remove-duplicates
                                   (mapcar (lambda (e)
                                             (quasar.protocol:json-value e "transactionId"))
                                           parsed-events)
                                   :test #'string=))
                        (op-ids (mapcar (lambda (e)
                                          (quasar.protocol:json-value e "operationId"))
                                        parsed-events))
                        (revisions (mapcar (lambda (e)
                                            (quasar.protocol:json-value e "revision"))
                                          parsed-events)))
                   (check (= 1 (length txn-ids)))
                   (check (= (length op-ids)
                             (length (remove-duplicates op-ids :test #'string=))))
                   (check (equal '(1 2)
                                 (mapcar (lambda (event)
                                           (quasar.protocol:json-value event "eventIndex"))
                                         parsed-events)))
                   (check (every (lambda (event)
                                   (= 2 (quasar.protocol:json-value event "eventCount")))
                                 parsed-events))
                   (check (= 1 (length (remove-duplicates revisions))))
                   (check (search "person:tx1" (first events)))
                   (check (search "person:tx2" (second events)))))))
        (quasar.control-plane:unsubscribe plane sub-id)
        (stop-control-plane plane)))))

;;; --- Unknown command / dispatch ---

(defun test-unknown-command ()
  (let ((plane (make-control-plane)))
    (start-control-plane plane)
    (unwind-protect
         (let ((response (call-command
                          plane
                          (make-envelope "totally.unknown" (quasar.protocol:empty-object)
                                         :id "unk-1"))))
           (check (string= (status response) "error"))
           (check (string= (error-code response) "protocol.unknown-command")))
      (stop-control-plane plane))))

;;; --- Full command dispatch through the actor ---

(defun test-dispatch-document-create ()
  (let ((plane (make-control-plane)))
    (setf *events-box* (cons nil nil))
    (start-control-plane plane)
    (let ((sub-id (quasar.control-plane:subscribe plane (event-collector))))
      (unwind-protect
           (let* ((response
                    (call-command
                     plane
                     (make-envelope
                      "document.create"
                      (make-doc "dispatch-1")
                      :id "dc-1")))
                  (parsed-result (result response)))
             (check (string= (status response) "ok"))
             (check (string= (jsown:val parsed-result "event") "document.created"))
             (check (jsown:val parsed-result "operationId"))
             (check (jsown:val parsed-result "revision"))
             (sleep 0.1)
             (check (some (lambda (e)
                            (search "\"event\":\"document.created\"" e))
                          (car *events-box*))))
        (quasar.control-plane:unsubscribe plane sub-id)
        (stop-control-plane plane)))))

(defun test-dispatch-snapshot ()
  (let ((plane (make-control-plane)))
    (start-control-plane plane)
    (unwind-protect
         (progn
           (call-command
            plane
            (make-envelope "document.create" (make-doc "snap-1") :id "s-1"))
           (sleep 0.1)
           (let ((response (call-command
                             plane
                             (make-envelope "workspace.snapshot"
                                            (quasar.protocol:empty-object)
                                            :id "s-2"))))
             (check (string= (status response) "ok"))
             (check (search "snap-1" response))))
      (stop-control-plane plane))))

(defun test-graph-snapshot ()
  (let ((plane (make-control-plane)))
    (start-control-plane plane)
    (unwind-protect
         (progn
           (call-command
            plane
            (make-envelope "graph.node.create"
                           (make-node "gsnap" "gn-1")
                           :id "gs-1"))
           (sleep 0.1)
           (let ((response (call-command
                             plane
                             (make-envelope "graph.snapshot"
                                            (quasar.protocol:json-object
                                             (cons "graphId" "gsnap"))
                                            :id "gs-2"))))
             (check (string= (status response) "ok"))
             (check (search "gn-1" response))))
      (stop-control-plane plane))))

(defun run-tests ()
  (setf *failures* 0
        *events-box* (cons nil nil))
  (test-protocol-decode)
  (test-protocol-encode)
  (test-clone-json)
  (test-workspace-revision)
  (test-document-crud)
  (test-document-not-found)
  (test-document-invalid)
  (test-node-crud)
  (test-node-not-found)
  (test-node-invalid-document-ref)
  (test-edge-crud)
  (test-edge-invalid-reference)
  (test-node-delete-removes-edges)
  (test-document-delete-blocked-by-graph)
  (test-duplicate-id-rejection)
  (test-transaction-rollback)
  (test-transaction-graph-isolation)
  (test-transaction-graph-rollback)
  (test-inverse-round-trip-document)
  (test-inverse-round-trip-node)
  (test-node-delete-inverse-restores-edges)
  (test-document-delete-membership-inverse)
  (test-inverse-round-trip-edge)
  (test-inverse-round-trip-update)
  (test-store-roundtrip)
  (test-store-journal)
  (test-store-restart-restore)
  (test-control-plane-persistence)
  (test-control-plane-restart-from-store)
  (test-persistence-failure-does-not-commit)
  (test-failed-transaction-has-no-side-effects)
  (test-transaction-event-sequencing)
  (test-unknown-command)
  (test-dispatch-document-create)
  (test-dispatch-snapshot)
  (test-graph-snapshot)
  (when (plusp *failures*)
    (error "~D Quasar test(s) failed." *failures*))
  (format t "~&Quasar tests passed.~%")
  t)
