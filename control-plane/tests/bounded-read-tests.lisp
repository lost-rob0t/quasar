(in-package #:quasar.tests)

(defun bounded-fixture-document (index &optional (body-size 1024))
  (quasar.protocol:json-object
   (cons "id" (format nil "bounded:~8,'0D" index))
   (cons "dtype" (if (evenp index) "person" "organization"))
   (cons "dataset" (if (evenp index) "alpha" "beta"))
   (cons "schemaVersion" "0.10.1")
   (cons "updatedAt" index)
   (cons "notes" (format nil "needle-~D" index))
   (cons "extensions" (quasar.protocol:json-object
                       (cons "body" (make-string body-size :initial-element #\x))))))

(defun seed-bounded-fixture (store count &optional (workspace "bounded") (body-size 1024))
  "Isolated fixtures use exported Tek9 writes and the existing canonical key encoding."
  (let ((database (quasar.store::tek9-store-database store)))
    (quasar.protocol:require-canonical-document (bounded-fixture-document 0 body-size))
    (tek9:with-write-transaction (database)
      (loop for offset from 0 below count by 128
            do (tek9:put-bulk
                database
                (loop for index from offset below (min count (+ offset 128))
                      for document = (bounded-fixture-document index body-size)
                      collect (tek9:new-document
                               :id (quasar.store::%document-key workspace (quasar.protocol:json-value document "id"))
                               :value document))))
      (quasar.store::%put-record database (quasar.store::%workspace-meta-key workspace)
                                 (quasar.store::%default-workspace-meta workspace 1 count)))))

(defun with-bounded-read-instrumentation (thunk)
  "Fail on hydration, cloning, graph restoration, or unlimited primary scans."
  (let ((originals nil) (ranges 0))
    (unwind-protect
         (progn
           (dolist (symbol '(quasar.store:load-workspace quasar.workspace:copy-workspace
                             quasar.control-plane::workspace-for quasar.store::%range-values
                             quasar.store::%restore-metadata-workspace
                             tek9:fetch-graph-nodes tek9:fetch-graph-edges))
             (push (cons symbol (symbol-function symbol)) originals)
             (let ((name symbol))
               (setf (symbol-function symbol)
                     (lambda (&rest arguments)
                       (declare (ignore arguments))
                       (error "Forbidden eager read: ~A" name)))))
           (let ((original (symbol-function 'tek9:select-primary-range)))
             (push (cons 'tek9:select-primary-range original) originals)
             (setf (symbol-function 'tek9:select-primary-range)
                   (lambda (database start &rest options &key limit &allow-other-keys)
                     (unless (and (integerp limit) (<= 1 limit 2))
                       (error "Unbounded primary range: ~S" options))
                     (incf ranges)
                     (apply original database start options))))
           (funcall thunk)
           ranges)
      (dolist (pair originals) (setf (symbol-function (car pair)) (cdr pair))))))

(defun bounded-query (store &rest pairs)
  (quasar.store:search-documents store "bounded" (apply #'quasar.protocol:json-object pairs)))

(defun bounded-error-p (code thunk)
  (handler-case (progn (funcall thunk) nil)
    (quasar.protocol:quasar-error (condition)
      (string= code (quasar.protocol:quasar-error-code condition)))))

(defun test-bounded-reads-and-continuations ()
  (with-temporary-tek9-store (store path "bounded-reads")
    (check (probe-file path))
    (seed-bounded-fixture store 120)
    (seed-bounded-fixture store 5 "other")
    (check
     (plusp
      (with-bounded-read-instrumentation
       (lambda ()
         (let ((bootstrap (quasar.store:workspace-bootstrap store "bounded")))
           (check (= 120 (quasar.protocol:json-value bootstrap "documentCount")))
           (check (eq :missing (quasar.protocol:json-value bootstrap "documents" :missing)))
           (check (eq :missing (quasar.protocol:json-value bootstrap "graphs" :missing))))
         (let* ((first (bounded-query store (cons "limit" 50)))
                (rows (array-elements-for-test (quasar.protocol:json-value first "documents")))
                (cursor (quasar.protocol:json-value first "cursor")))
           (check (= 50 (length rows)))
           (check (equal '("alpha" "beta")
                         (sort (remove-duplicates (mapcar (lambda (row) (quasar.protocol:json-value row "dataset")) rows)
                                                  :test #'string=) #'string<)))
           (check (every (lambda (row) (eq :missing (quasar.protocol:json-value row "extensions" :missing))) rows))
           (let ((second (bounded-query store (cons "limit" 50) (cons "cursor" cursor))))
             (check (string< (quasar.protocol:json-value (car (last rows)) "id")
                             (quasar.protocol:json-value (first (array-elements-for-test
                                                               (quasar.protocol:json-value second "documents"))) "id"))))
           (check (bounded-error-p "query.invalid-cursor"
                                   (lambda () (bounded-query store (cons "q" "different") (cons "cursor" cursor)))))
           (check (bounded-error-p "query.invalid-cursor"
                                   (lambda () (quasar.store:search-documents
                                               store "other" (quasar.protocol:json-object (cons "cursor" cursor))))))
           (let ((database (quasar.store::tek9-store-database store)))
             (tek9:with-write-transaction (database)
               (quasar.store::%put-record database (quasar.store::%workspace-meta-key "bounded")
                                          (quasar.store::%default-workspace-meta "bounded" 2 120))))
           (check (bounded-error-p "query.stale-cursor"
                                   (lambda () (bounded-query store (cons "cursor" cursor))))))
         (let ((seen 0) (cursor nil) (complete nil) (previous nil))
           (loop until complete
                 do (let* ((request (quasar.protocol:json-object (cons "limit" 17)))
                           (page (progn (when cursor (quasar.protocol:object-set request "cursor" cursor))
                                        (quasar.store:search-documents store "bounded" request))))
                      (dolist (row (array-elements-for-test (quasar.protocol:json-value page "documents")))
                        (let ((id (quasar.protocol:json-value row "id")))
                          (when previous (check (string< previous id)))
                          (setf previous id) (incf seen)))
                      (setf complete (eq t (quasar.protocol:json-value page "complete"))
                            cursor (quasar.protocol:json-value page "cursor"))))
           (check (= 120 seen)))
         (let ((page (bounded-query store (cons "datasets" (quasar.protocol:json-array "beta"))
                                    (cons "dtype" "organization") (cons "updatedAfter" 110))))
           (check (= 5 (length (array-elements-for-test (quasar.protocol:json-value page "documents"))))))
         (check (= 1 (length (array-elements-for-test
                             (quasar.protocol:json-value
                              (bounded-query store (cons "fields" (quasar.protocol:json-object (cons "notes" "needle-3"))))
                              "documents")))))
         (check (eq t (quasar.protocol:json-value (bounded-query store (cons "q" "absent")) "complete")))
         (let ((page (bounded-query store (cons "q" "absent") (cons "scanLimit" 7))))
           (check (= 7 (quasar.protocol:json-value (quasar.protocol:json-value page "performance") "scanned")))
           (check (not (eq t (quasar.protocol:json-value page "complete"))))
           (check (stringp (quasar.protocol:json-value page "cursor"))))
         (let ((page (quasar.store:fetch-document-batch
                      store "bounded" (quasar.protocol:json-object
                                       (cons "ids" (quasar.protocol:json-array "bounded:00000003" "missing" "bounded:00000003"))))))
           (check (= 1 (length (array-elements-for-test (quasar.protocol:json-value page "documents")))))
           (check (equal '("missing") (array-elements-for-test (quasar.protocol:json-value page "missingIds")))))
         (check (= 0 (quasar.protocol:json-value (quasar.store:workspace-bootstrap store "empty") "documentCount")))))))))

(defun test-bounded-query-budgets ()
  (with-temporary-tek9-store (store path "bounded-budgets")
    (check (probe-file path))
    (seed-bounded-fixture store 20 "bounded" 64000)
    (check (bounded-error-p "query.record-too-large"
                            (lambda () (quasar.store:fetch-document-batch
                                        store "bounded" (quasar.protocol:json-object
                                                         (cons "byteLimit" 32768)
                                                         (cons "ids" (quasar.protocol:json-array "bounded:00000000")))))))
    (dolist (request (list (quasar.protocol:json-object (cons "limit" 251))
                          (quasar.protocol:json-object (cons "byteLimit" 0))
                          (quasar.protocol:json-object (cons "scanLimit" 1001))
                          (quasar.protocol:json-object (cons "deadlineMs" 51))
                          (quasar.protocol:json-object (cons "unsupported" t))))
      (check (bounded-error-p "query.invalid" (lambda () (quasar.store:search-documents store "bounded" request)))))
    (check (bounded-error-p "query.invalid-cursor" (lambda () (bounded-query store (cons "cursor" "bad-json")))))
    (let* ((ticks 0)
           (quasar.store::*query-clock* (lambda () (incf ticks (* 2 internal-time-units-per-second))))
           (page (bounded-query store)))
      (check (string= "deadline" (quasar.protocol:json-value (quasar.protocol:json-value page "performance") "stopReason")))
      (check (stringp (quasar.protocol:json-value page "cursor"))))
    (check (<= (quasar.store::%utf8-length (quasar.protocol:encode (bounded-query store))) (* 512 1024)))))

(defun test-bounded-command-registration ()
  (with-temporary-tek9-store (store path "bounded-commands")
    (check (probe-file path))
    (seed-bounded-fixture store 10)
    (let ((plane (quasar.control-plane:start-control-plane (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (with-bounded-read-instrumentation
            (lambda ()
              (dolist (command '("workspace.bootstrap" "document.search"))
                (let ((response (call-command plane (make-envelope command (quasar.protocol:empty-object) :workspace "bounded"))))
                  (check (string= "ok" (status response)))))
              (check (= 0 (hash-table-count (quasar.control-plane:control-plane-workspaces plane))))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-bounded-websocket-authorization ()
  (with-temporary-tek9-store (store path "bounded-auth")
    (check (probe-file path))
    (seed-bounded-fixture store 10)
    (let* ((plane (quasar.control-plane:start-control-plane (quasar.control-plane:make-control-plane :store store)))
           (server (quasar.ws:make-websocket-server plane :insecure-development-p t))
           (original (symbol-function 'quasar.ws::send-connection-text))
           (response nil))
      (unwind-protect
           (progn
             (setf (symbol-function 'quasar.ws::send-connection-text)
                   (lambda (connection encoded) (declare (ignore connection)) (setf response encoded)))
             (dolist (command '("workspace.bootstrap" "document.search" "document.batch"))
               (let ((connection (make-instance 'quasar.ws::ws-connection
                                                :id "bounded-auth" :ws nil :session-id "bounded-auth"
                                                :session-token "bounded-auth" :principal "reader"
                                                :authorized-workspaces '("bounded")
                                                :capabilities (list command))))
                 (setf response nil)
                 (quasar.ws::handle-text-message server connection
                                                (make-envelope command (quasar.protocol:empty-object) :workspace "other"))
                 (check (string= "security.forbidden" (error-code response)))
                 (setf response nil)
                 (quasar.ws::handle-text-message server connection
                                                (make-envelope "document.create" (make-doc "unauthorized") :workspace "bounded"))
                 (check (string= "security.forbidden" (error-code response)))))
             (check (= 0 (hash-table-count (quasar.control-plane:control-plane-workspaces plane)))))
        (setf (symbol-function 'quasar.ws::send-connection-text) original)
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-bounded-byte-pagination-and-typed-projections ()
  (with-temporary-tek9-store (store path "bounded-byte-pages")
    (check (probe-file path))
    (seed-bounded-fixture store 300)
    (let ((seen 0) (cursor nil) (done nil) (byte-stops 0))
      (loop until done
            do (let* ((request (quasar.protocol:json-object (cons "limit" 250) (cons "byteLimit" 32768)))
                      (page (progn (when cursor (quasar.protocol:object-set request "cursor" cursor))
                                   (quasar.store:search-documents store "bounded" request))))
                 (check (<= (quasar.store::%utf8-length (quasar.protocol:encode page)) 32768))
                 (when (equal "bytes" (quasar.protocol:json-value (quasar.protocol:json-value page "performance") "stopReason"))
                   (incf byte-stops))
                 (incf seen (length (array-elements-for-test (quasar.protocol:json-value page "documents"))))
                 (setf done (eq t (quasar.protocol:json-value page "complete"))
                       cursor (quasar.protocol:json-value page "cursor"))))
      (check (= 300 seen))
      (check (plusp byte-stops)))
    (let* ((relation (quasar.protocol:json-object
                      (cons "id" "typed:relation") (cons "dtype" "relation")
                      (cons "dataset" "alpha") (cons "schemaVersion" "0.10.1")
                      (cons "predicate" "employed-by")
                      (cons "source" (quasar.protocol:json-object (cons "id" "bounded:00000000") (cons "schema" "person")))
                      (cons "destination" (quasar.protocol:json-object (cons "id" "bounded:00000001") (cons "schema" "organization")))))
           (database (quasar.store::tek9-store-database store)))
      (quasar.protocol:require-canonical-document relation)
      (tek9:with-write-transaction (database)
        (quasar.store::%put-record database (quasar.store::%document-key "bounded" "typed:relation") relation))
      (let* ((page (bounded-query store (cons "predicate" "employed-by")))
             (row (first (array-elements-for-test (quasar.protocol:json-value page "documents")))))
        (check (equal (quasar.protocol:json-value relation "source") (quasar.protocol:json-value row "source")))
        (check (equal "employed-by" (quasar.protocol:json-value row "predicate")))))
    (check (bounded-error-p "query.invalid"
                            (lambda () (quasar.store:fetch-document-batch store "bounded" (quasar.protocol:empty-object)))))))

(defun run-bounded-read-tests ()
  (let ((*failures* 0))
    (test-bounded-reads-and-continuations)
    (test-bounded-query-budgets)
    (test-bounded-command-registration)
    (test-bounded-websocket-authorization)
    (test-bounded-byte-pagination-and-typed-projections)
    (when (plusp *failures*) (error "~D bounded-read test checks failed." *failures*))
    t))
