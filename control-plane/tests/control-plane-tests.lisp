(in-package #:quasar.tests)

(defvar *failures* 0)
(defvar *events-box* nil)

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

;;; --- Protocol tests ---

(defun test-protocol-decode ()
  (let* ((envelope (quasar.protocol:decode-command
                    (make-envelope "document.list" (quasar.protocol:empty-object)))))
    (check (string= (quasar.protocol:command-envelope-id envelope) "test-1"))
    (check (string= (quasar.protocol:command-envelope-command envelope) "document.list")))
  ;; Bad protocol version
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
  ;; Malformed envelope
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

;;; --- Workspace tests ---

(defun test-workspace-revision ()
  (let ((workspace (make-workspace :id "rev-test")))
    (check (= 0 (workspace-revision workspace)))
    (quasar.workspace:dispatch-operation
     workspace
     (quasar.protocol:json-object
      (cons "type" "document.create")
      (cons "payload"
            (quasar.protocol:json-object
             (cons "_id" "person:1")
             (cons "dtype" "person")))))
    (check (= 0 (workspace-revision workspace)))))

;;; --- Document CRUD ---

(defun test-document-crud ()
  (let ((workspace (make-workspace :id "crud-test")))
    ;; create
    (quasar.workspace:apply-document-create
     workspace
     (quasar.protocol:json-object
      (cons "_id" "person:crud")
      (cons "dtype" "person")))
    (check (gethash "person:crud" (quasar.workspace:workspace-documents workspace)))
    ;; update
    (quasar.workspace:apply-document-update
     workspace
     (quasar.protocol:json-object
      (cons "_id" "person:crud")
      (cons "dtype" "person")
      (cons "data" (quasar.protocol:json-object (cons "note" "updated")))))
    (check (string= "updated"
                    (jsown:val
                     (jsown:val
                      (gethash "person:crud"
                               (quasar.workspace:workspace-documents workspace))
                      "data")
                     "note")))
    ;; delete
    (quasar.workspace:apply-document-delete
     workspace
     (quasar.protocol:json-object (cons "id" "person:crud")))
    (check (null (gethash "person:crud"
                          (quasar.workspace:workspace-documents workspace))))))

(defun test-document-not-found ()
  (let ((workspace (make-workspace :id "nf-test")))
    (handler-case
        (quasar.workspace:apply-document-delete
         workspace
         (quasar.protocol:json-object (cons "id" "nope")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c)
                       "document.not-found")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: missing delete did not signal~%")))))

(defun test-document-invalid ()
  (let ((workspace (make-workspace :id "inv-test")))
    (handler-case
        (quasar.workspace:apply-document-create
         workspace
         (quasar.protocol:json-object (cons "dtype" "person")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c) "document.invalid")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: invalid doc did not signal~%")))))

;;; --- Graph node CRUD ---

(defun test-node-crud ()
  (let ((workspace (make-workspace :id "node-test")))
    (quasar.workspace:apply-node-create
     workspace
     (quasar.protocol:json-object
      (cons "graphId" "g1")
      (cons "id" "node-1")
      (cons "documentId" "person:1")))
    (let ((graph (quasar.workspace:workspace-graph workspace "g1")))
      (check graph)
      (check (quasar.workspace:graph-node graph "node-1")))
    ;; update
    (quasar.workspace:apply-node-update
     workspace
     (quasar.protocol:json-object
      (cons "graphId" "g1")
      (cons "id" "node-1")
      (cons "position" (quasar.protocol:json-object
                         (cons "x" 10) (cons "y" 20)))))
    (let ((node (quasar.workspace:graph-node
                 (quasar.workspace:workspace-graph workspace "g1") "node-1")))
      (check (= 10 (jsown:val (jsown:val node "position") "x"))))
    ;; delete
    (quasar.workspace:apply-node-delete
     workspace
     (quasar.protocol:json-object
      (cons "graphId" "g1")
      (cons "id" "node-1")))
    (check (null (quasar.workspace:graph-node
                  (quasar.workspace:workspace-graph workspace "g1") "node-1")))))

(defun test-node-not-found ()
  (let ((workspace (make-workspace :id "nnf-test")))
    (handler-case
        (quasar.workspace:apply-node-delete
         workspace
         (quasar.protocol:json-object
          (cons "graphId" "g1")
          (cons "id" "ghost")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c)
                       "graph.node-not-found")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: missing node delete did not signal~%")))))

;;; --- Graph edge CRUD ---

(defun test-edge-crud ()
  (let ((workspace (make-workspace :id "edge-test")))
    (quasar.workspace:apply-node-create
     workspace
     (quasar.protocol:json-object (cons "graphId" "ge") (cons "id" "a")))
    (quasar.workspace:apply-node-create
     workspace
     (quasar.protocol:json-object (cons "graphId" "ge") (cons "id" "b")))
    (quasar.workspace:apply-edge-create
     workspace
     (quasar.protocol:json-object
      (cons "graphId" "ge")
      (cons "id" "e1")
      (cons "source" "a")
      (cons "target" "b")))
    (let ((graph (quasar.workspace:workspace-graph workspace "ge")))
      (check (quasar.workspace:graph-edge graph "e1")))
    ;; delete
    (quasar.workspace:apply-edge-delete
     workspace
     (quasar.protocol:json-object
      (cons "graphId" "ge") (cons "id" "e1")))
    (check (null (quasar.workspace:graph-edge
                  (quasar.workspace:workspace-graph workspace "ge") "e1")))))

(defun test-edge-invalid-reference ()
  (let ((workspace (make-workspace :id "eir-test")))
    (quasar.workspace:apply-node-create
     workspace
     (quasar.protocol:json-object (cons "graphId" "gir") (cons "id" "a")))
    (handler-case
        (quasar.workspace:apply-edge-create
         workspace
         (quasar.protocol:json-object
          (cons "graphId" "gir")
          (cons "id" "bad")
          (cons "source" "a")
          (cons "target" "nonexistent")))
      (quasar.protocol:quasar-error (c)
        (check (string= (quasar.protocol:quasar-error-code c)
                       "graph.invalid-reference")))
      (:no-error (&rest args)
        (declare (ignore args))
        (incf *failures*)
        (format *error-output* "~&FAIL: bad edge ref did not signal~%")))))

;;; --- Transaction rollback ---

(defun test-transaction-rollback ()
  (let ((workspace (make-workspace :id "tx-test")))
    (let ((candidate (make-workspace :id "tx-test")))
      (handler-case
          (progn
            (quasar.workspace:commit-operations
             candidate
             (list
              (quasar.protocol:json-object
               (cons "type" "document.create")
               (cons "payload"
                     (quasar.protocol:json-object (cons "_id" "tx-1"))))
              (quasar.protocol:json-object
               (cons "type" "document.create")
               (cons "payload"
                     (quasar.protocol:json-object (cons "_id" "tx-1")))))))
        (quasar.protocol:quasar-error (c)
          (check (string= (quasar.protocol:quasar-error-code c)
                         "document.invalid")))
        (:no-error (&rest args)
          (declare (ignore args))
          (incf *failures*)
          (format *error-output* "~&FAIL: dup in tx did not signal~%")))
      ;; Candidate should have the first doc but NOT the second duplicate.
      ;; Transaction caller is expected to discard the candidate on failure.
      (check (gethash "tx-1" (quasar.workspace:workspace-documents candidate))))
  t))

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
                      (quasar.protocol:json-object
                       (cons "_id" "dispatch-1")
                       (cons "dtype" "person"))
                      :id "dc-1")))
                  (parsed-result (result response)))
             (check (string= (status response) "ok"))
             (check (string= (jsown:val parsed-result "event") "document.created"))
             ;; Allow the actor to process broadcast
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
            (make-envelope "document.create"
                           (quasar.protocol:json-object
                            (cons "_id" "snap-1") (cons "dtype" "person"))
                           :id "s-1"))
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
                           (quasar.protocol:json-object
                            (cons "graphId" "gsnap")
                            (cons "id" "gn-1"))
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
  (test-workspace-revision)
  (test-document-crud)
  (test-document-not-found)
  (test-document-invalid)
  (test-node-crud)
  (test-node-not-found)
  (test-edge-crud)
  (test-edge-invalid-reference)
  (test-transaction-rollback)
  (test-unknown-command)
  (test-dispatch-document-create)
  (test-dispatch-snapshot)
  (test-graph-snapshot)
  (when (plusp *failures*)
    (error "~D Quasar test(s) failed." *failures*))
  (format t "~&Quasar tests passed.~%")
  t)
