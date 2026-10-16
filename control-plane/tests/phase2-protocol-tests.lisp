(in-package #:quasar.tests)

(defun phase2-protocol-chunk-response (plane session-id sequence operations &key (id "phase2-protocol"))
  (call-command
   plane
   (make-envelope
    "document.import.chunk"
    (quasar.protocol:json-object
     (cons "sessionId" session-id)
     (cons "sequence" sequence)
     (cons "operations" operations))
    :id id)))

(defun test-phase2-malformed-import-protocol ()
  (with-temporary-tek9-store (store path "phase2-protocol")
    (check (probe-file path))
    (let ((plane
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin)))
             (flet ((expect-error (response code)
                      (check (string= "error" (status response)))
                      (check (string= code (error-code response)))))
               (expect-error
                (call-command
                 plane
                 (make-envelope
                  "document.import.chunk"
                  (quasar.protocol:json-object
                   (cons "sequence" 0)
                   (cons "operations" (quasar.protocol:json-array)))
                  :id "missing-session"))
                "import.invalid-session")
               (expect-error
                (call-command
                 plane
                 (make-envelope
                  "document.import.chunk"
                  (quasar.protocol:json-object
                   (cons "sessionId" 42)
                   (cons "sequence" 0)
                   (cons "operations" (quasar.protocol:json-array)))
                  :id "non-string-session"))
                "import.invalid-session")
               (dolist (value '(-1 1.5d0))
                 (expect-error
                  (phase2-protocol-chunk-response
                   plane session-id value (quasar.protocol:json-array)
                   :id (format nil "bad-sequence-~A" value))
                  "import.invalid-sequence"))
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id (expt 2 100) (quasar.protocol:json-array)
                 :id "massive-sequence")
                "import.sequence-gap")
               (expect-error
                (call-command
                 plane
                 (make-envelope
                  "document.import.chunk"
                  (quasar.protocol:json-object
                   (cons "sessionId" session-id)
                   (cons "sequence" 0))
                  :id "missing-operations"))
                "protocol.invalid-envelope")
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id 0 (quasar.protocol:json-object)
                 :id "object-operations")
                "protocol.invalid-envelope")
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id 0
                 (quasar.protocol:json-array
                  (quasar.protocol:json-object
                   (cons "type" "document.delete")
                   (cons "payload"
                         (quasar.protocol:json-object (cons "id" "x")))))
                 :id "unsupported-operation")
                "import.invalid-operation")
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id 0
                 (quasar.protocol:json-array
                  (quasar.protocol:json-object
                   (cons "type" "document.create")
                   (cons "payload"
                         (quasar.protocol:json-object (cons "id" "missing-dtype")))))
                 :id "missing-dtype")
                "document.invalid")
               (let ((oversized
                       (quasar.protocol:json-array
                        (quasar.protocol:json-object
                         (cons "type" "document.create")
                         (cons "payload"
                               (quasar.protocol:json-object
                                (cons "id" "oversized")
                                (cons "dtype" "person") (cons "schemaVersion" "0.10.1") (cons "dataset" "test")
                                (cons "notes"
                                      (make-string
                                       (+ (* 1024 1024) 1024)
                                       :initial-element #\x))))))))
                 (expect-error
                  (phase2-protocol-chunk-response
                   plane session-id 0 oversized :id "oversized-chunk")
                  "import.chunk-too-large"))
               (let ((too-many
                       (apply
                        #'quasar.protocol:json-array
                        (loop repeat 1001
                              collect
                                (quasar.protocol:json-object
                                 (cons "type" "document.create")
                                 (cons "payload"
                                       (quasar.protocol:json-object
                                        (cons "id" "unused")
                                        (cons "dtype" "person") (cons "schemaVersion" "0.10.1") (cons "dataset" "test"))))))))
                 (expect-error
                  (phase2-protocol-chunk-response
                   plane session-id 0 too-many :id "too-many-operations")
                  "import.chunk-too-many-operations"))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-invalid-stage-does-not-become-canonical ()
  (with-temporary-tek9-store (store path "phase2-invalid-stage")
    (check (probe-file path))
    (let ((plane
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin))
                  (bad
                    (phase2-protocol-chunk-response
                     plane
                     session-id
                     0
                     (quasar.protocol:json-array
                      (quasar.protocol:json-object
                       (cons "type" "document.create")
                       (cons "payload"
                             (quasar.protocol:json-object
                              (cons "id" "never-canonical")))))
                     :id "invalid-stage-chunk")))
             (check (string= "error" (status bad)))
             (check (string= "document.invalid" (error-code bad)))
             (check (= 0 (quasar.store:direct-workspace-revision store "default")))
             (let ((get
                     (call-command
                      plane
                      (make-envelope
                       "document.get"
                       (quasar.protocol:json-object (cons "id" "never-canonical"))
                       :id "never-canonical-get"))))
               (check (string= "document.not-found" (error-code get)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun call-with-requested-graph-instrumentation (store workspace-id graph-id thunk)
  "Reject every exported storage call outside the requested graph. Return counts."
  (let* ((originals nil)
         (reads 0)
         (topology-reads 0)
         (database (quasar.store::tek9-store-database store))
         (namespace (quasar.store::%graph-namespace workspace-id graph-id))
         (meta-key (quasar.store::%graph-meta-key workspace-id graph-id))
         (node-prefix (quasar.store::%node-prefix workspace-id graph-id))
         (edge-prefix (quasar.store::%edge-prefix workspace-id graph-id)))
    (unwind-protect
         (progn
           (dolist (symbol '(quasar.store:load-workspace
                             quasar.store::%restore-metadata-workspace
                             tek9:select-primary-range))
             (push (cons symbol (symbol-function symbol)) originals)
             (let ((name symbol))
               (setf (symbol-function symbol)
                     (lambda (&rest arguments)
                       (declare (ignore arguments))
                       (error "Unexpected graph snapshot enumeration: ~A" name)))))
           (let ((original (symbol-function 'tek9:fetch*)))
             (push (cons 'tek9:fetch* original) originals)
             (setf (symbol-function 'tek9:fetch*)
                   (lambda (db key &rest arguments)
                     (assert (eq database db))
                     (assert (or (equal key meta-key)
                                 (quasar.store::%prefix-p node-prefix key)
                                 (quasar.store::%prefix-p edge-prefix key)))
                     (incf reads)
                     (apply original db key arguments))))
           (dolist (symbol '(tek9:fetch-graph-nodes tek9:fetch-graph-edges))
             (let ((original (symbol-function symbol)))
               (push (cons symbol original) originals)
               (setf (symbol-function symbol)
                     (lambda (db graph-namespace &rest arguments)
                       (assert (eq database db))
                       (assert (equal namespace graph-namespace))
                       (incf topology-reads)
                       (apply original db graph-namespace arguments)))))
           (funcall thunk)
           (list reads topology-reads))
      (dolist (pair originals)
        (setf (symbol-function (car pair)) (cdr pair))))))

(defun test-direct-graph-snapshot-isolation ()
  (with-temporary-tek9-store (store path "requested-graph")
    (let* ((workspace (quasar.workspace:make-workspace :id "requested"))
           (expected (graph-payload-for-restart-test)))
      (setf (quasar.workspace:workspace-graph workspace "case") expected)
      (quasar.store:save-workspace store workspace)
      (flet ((read-and-check ()
               (call-with-requested-graph-instrumentation
                store "requested" "case"
                (lambda ()
                  (let ((graph (quasar.store:direct-graph-snapshot store "requested" "case")))
                    ;; Include membership, presentation, node and edge sidecars.
                    ;; Storage may reorder topology: compare each record by ID.
                    (dolist (field '("id" "name" "documentIds" "positions" "viewport" "layout" "groups"))
                      (check (equalp (quasar.protocol:json-value expected field)
                                     (quasar.protocol:json-value graph field))))
                    (check (= 2 (length (quasar.workspace:array-elements
                                        (quasar.protocol:json-value graph "nodes")))))
                    (check (= 1 (length (quasar.workspace:array-elements
                                        (quasar.protocol:json-value graph "edges")))))
                    (dolist (id '("n1" "n2"))
                      (check (equalp (quasar.workspace:graph-node expected id)
                                     (quasar.workspace:graph-node graph id))))
                    (check (equalp (quasar.workspace:graph-edge expected "edge:1")
                                   (quasar.workspace:graph-edge graph "edge:1")))
                    (quasar.protocol:object-set graph "name" "caller changed this"))))))
        (let ((baseline (read-and-check)))
          (check (equal '(4 2) baseline))
          ;; Increase unrelated persisted topology and metadata, then reopen.
          ;; No unrelated record is permitted in any measured read.
          (loop for index below 24
                for id = (format nil "unrelated-~D" index)
                for graph = (quasar.protocol:json-object
                             (cons "id" id) (cons "name" id)
                             (cons "documentIds" (cons :array (loop for n below 256 collect (format nil "doc-~D" n))))
                             (cons "positions" (quasar.protocol:json-object
                                                 (cons "large" (make-string 65536 :initial-element #\x))))
                             (cons "nodes" (cons :array
                                                  (loop for n below 64
                                                        collect (quasar.protocol:json-object
                                                                 (cons "id" (format nil "node-~D" n))))))
                             (cons "edges" (quasar.protocol:json-array)))
                do (setf (quasar.workspace:workspace-graph workspace id) graph))
          (quasar.store:save-workspace store workspace)
          (check (equal baseline (read-and-check)))
          (quasar.store:close-store store)
          (setf store (quasar.store:make-tek9-store :path path))
          (check (equal baseline (read-and-check)))
          (check (handler-case
                     (progn (quasar.store:direct-graph-snapshot store "another-workspace" "case") nil)
                   (quasar.protocol:quasar-error (condition)
                     (string= "graph.not-found" (quasar.protocol:quasar-error-code condition)))))
          (check (handler-case
                     (progn (quasar.store:direct-graph-snapshot store "requested" "missing") nil)
                   (quasar.protocol:quasar-error (condition)
                     (string= "graph.not-found" (quasar.protocol:quasar-error-code condition))))))))))

(defun run-phase2-protocol-tests ()
  (let ((*failures* 0))
    (test-phase2-malformed-import-protocol)
    (test-direct-graph-snapshot-isolation)
    (test-phase2-invalid-stage-does-not-become-canonical)
    (when (plusp *failures*)
      (error "~D Phase 2 protocol tests failed." *failures*))
    t))