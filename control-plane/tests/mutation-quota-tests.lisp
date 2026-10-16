(in-package #:quasar.tests)

(defun assert-mutation-quota-exact (store workspace-id)
  (let* ((workspace (quasar.store:load-workspace store workspace-id))
         (revision (quasar.workspace:workspace-revision workspace))
         (database (quasar.store::tek9-store-database store))
         (state (tek9:fetch* database (quasar.store::%quota-key workspace-id))))
    (check state)
    (check (= revision (quasar.protocol:json-value state "revision")))
    (check (= (quasar.store::%json-octet-count
               (quasar.workspace:workspace-snapshot workspace))
              (quasar.store::%quota-snapshot-size
               workspace-id revision (quasar.store::%workspace-settings-object workspace)
               state)))))

(defun run-mutation-quota-tests ()
  (with-temporary-tek9-store (store path "mutation-quota")
    (let* ((plane (quasar.control-plane:make-control-plane :store store))
           (workspace-id "default")
           (envelope (quasar.protocol:decode-command
                      (make-envelope "workspace.transaction"
                                     (quasar.protocol:empty-object))))
           (payload (quasar.protocol:json-object
                     (cons "operations" (quasar.protocol:json-array
                      (phase3-transaction-operation "document.create" (make-doc "quota:雪"))
                      (phase3-transaction-operation "document.update"
                        (phase3-document (cons "id" "quota:雪") (cons "dtype" "person")
                                         (cons "text" "λ雪\"\\"))))))))
      ;; This direct single-writer test binds the actual authenticated principal;
      ;; quota rejection must roll back records, accounting, revision and events.
      (let ((quasar.control-plane::*command-principal* "quota-test")
            (events nil))
        (quasar.control-plane:subscribe plane (lambda (event) (push event events)))
        (unwind-protect
             (progn
               (quasar.plugin:set-storage-quota-resolver
                (lambda (principal) (check (string= principal "quota-test")) 1))
               (handler-case
                   (progn (quasar.control-plane::handle-record-transaction plane payload envelope)
                          (check nil))
                 (quasar.protocol:quasar-error (condition)
                   (check (string= "storage.quota-exceeded"
                                   (quasar.protocol:quasar-error-code condition)))))
               (check (null events))
               (check (zerop (quasar.store:direct-workspace-revision store workspace-id)))
               (check (null (quasar.store:direct-document store workspace-id "quota:雪")))
               (check (null (tek9:fetch* (quasar.store::tek9-store-database store)
                                        (quasar.store::%quota-key workspace-id))))
               (quasar.plugin:set-storage-quota-resolver
                (lambda (principal) (declare (ignore principal)) 1000000))
               (quasar.control-plane::handle-record-transaction plane payload envelope)
               (check (= 2 (length events)))
               (assert-mutation-quota-exact store workspace-id)
               (quasar.control-plane::run-record-operation
                plane envelope (phase3-transaction-operation
                                "document.delete"
                                (quasar.protocol:json-object (cons "id" "quota:雪"))))
               (assert-mutation-quota-exact store workspace-id))
          (quasar.plugin:reset-plugin-policy))))))

(defun test-graph-only-overlay-does-not-read-unrelated-corpus ()
  ;; Actual fixture sizes, measurements and scan counters are emitted only
  ;; when executed. Fixture creation is outside the measured mutation.
  (dolist (count '(10000 100000))
    (phase3-with-durable-corpus
     (format nil "graph-only-overlay-~D" count) count
     (lambda (store plane)
       (declare (ignore store))
       (let* ((original (symbol-function 'quasar.store::%bounded-range))
              (doc-prefix (quasar.store::%document-prefix "large-corpus"))
              (reads 0))
         (unwind-protect
              (progn
                (setf (symbol-function 'quasar.store::%bounded-range)
                      (lambda (database prefix &rest arguments)
                        (when (or (equal prefix doc-prefix) (search "/journal/" prefix))
                          (error "Graph-only mutation read unrelated corpus/history."))
                        (incf reads)
                        (apply original database prefix arguments)))
                (let ((metrics
                        (measure-bounded-operation
                         (format nil "graph-put-activate-~D" count)
                         (lambda ()
                           (let ((response
                                   (call-command plane
                                    (make-envelope "workspace.transaction"
                                     (quasar.protocol:json-object
                                      (cons "operations"
                                       (quasar.protocol:json-array
                                        (phase3-transaction-operation "graph.put"
                                         (quasar.protocol:json-object
                                          (cons "id" "graph-only") (cons "name" "graph-only")
                                          (cons "documentIds" (quasar.protocol:json-array))
                                          (cons "nodes" (quasar.protocol:json-array))
                                          (cons "edges" (quasar.protocol:json-array))))
                                        (phase3-transaction-operation "graph.activate"
                                         (quasar.protocol:json-object (cons "id" "graph-only"))))))
                                     :workspace "large-corpus"))))
                             (check (string= "ok" (status response)))
                             (parsed response))))))
                  (phase3-assert-no-workspace-corpus-cache plane)
                  (quasar.protocol:object-set metrics "corpusDocuments" count)
                  (quasar.protocol:object-set metrics "rangeCalls" reads)
                  (quasar.protocol:object-set metrics "dynamicSpaceBytes" (sb-ext:dynamic-space-size))
                  (format t "~&MUTATION-MEASUREMENT ~A~%" (quasar.protocol:encode metrics)))
                (setf reads 0)
                (let ((metrics
                        (measure-bounded-operation
                         (format nil "single-document-update-~D" count)
                         (lambda ()
                           (let ((response
                                   (call-command plane
                                    (make-envelope "document.update"
                                     (make-doc (phase2-large-corpus-id (1- count)))
                                     :workspace "large-corpus"))))
                             (check (string= "ok" (status response)))
                             (parsed response))))))
                  (phase3-assert-no-workspace-corpus-cache plane)
                  (quasar.protocol:object-set metrics "corpusDocuments" count)
                  (quasar.protocol:object-set metrics "rangeCalls" reads)
                  (quasar.protocol:object-set metrics "dynamicSpaceBytes" (sb-ext:dynamic-space-size))
                  (format t "~&MUTATION-MEASUREMENT ~A~%" (quasar.protocol:encode metrics))))
           (setf (symbol-function 'quasar.store::%bounded-range) original)))))))
