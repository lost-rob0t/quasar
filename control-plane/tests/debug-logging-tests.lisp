(in-package #:quasar.tests)

(defun test-operation-failure-carries-diagnostic-context ()
  (let* ((workspace (quasar.workspace:make-workspace :id "diagnostics-test"))
         (operation
           (quasar.protocol:json-object
            (cons "type" "graph.node.create")
            (cons "payload"
                  (quasar.protocol:json-object
                   (cons "graphId" "diagnostics-graph")
                   (cons "id" "node:missing-document")
                   (cons "documentId" "document:does-not-exist"))))))
    (handler-case
        (progn
          (quasar.workspace:commit-operations workspace (list operation))
          (error "Expected graph.invalid-reference."))
      (quasar.protocol:quasar-error (condition)
        (let ((details (quasar.protocol:quasar-error-details condition)))
          (check (string= "graph.invalid-reference"
                          (quasar.protocol:quasar-error-code condition)))
          (check (= 1 (quasar.protocol:json-value details "operationIndex")))
          (check (string= "graph.node.create"
                          (quasar.protocol:json-value details "operationType")))
          (check (string= "node:missing-document"
                          (quasar.protocol:json-value details "id")))
          (check (string= "document:does-not-exist"
                          (quasar.protocol:json-value details "documentId")))
          (check (string= "diagnostics-graph"
                          (quasar.protocol:json-value details "graphId"))))))))

(defun test-local-log-level-defaults-to-debug ()
  (unless (or (uiop:getenv "QUASAR_LOG_LEVEL")
              (uiop:getenv "CI"))
    (check (eq :debug (quasar.control-plane::configured-log-level)))))

(defun run-debug-logging-tests ()
  (test-operation-failure-carries-diagnostic-context)
  (test-local-log-level-defaults-to-debug)
  t)
