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

(defun test-bounded-workspace-admission-types ()
  "Admission and dispatch must agree on the exact typed workspace identity."
  (with-temporary-tek9-store (store path "bounded-workspace-types")
    (check (probe-file path))
    (seed-bounded-fixture store 3 "default")
    (seed-bounded-fixture store 2 "NULL")
    (seed-bounded-fixture store 1 "FALSE")
    (let* ((plane (quasar.control-plane:start-control-plane
                   (quasar.control-plane:make-control-plane :store store)))
           (server (quasar.ws:make-websocket-server plane :insecure-development-p t))
           (send-original (symbol-function 'quasar.ws::send-connection-text))
           (originals nil) (reads 0) (response nil))
      (labels ((wire (command workspace-json)
                 (format nil "{\"protocol\":\"quasar.control.v1\",\"id\":\"bounded-types\",\"command\":~S,\"payload\":~A~A}"
                         command
                         (if (string= command "document.batch")
                             "{\"ids\":[\"bounded:00000000\"]}" "{}")
                         (if workspace-json
                             (format nil ",\"metadata\":{\"workspace\":~A}" workspace-json) "")))
               (exchange (command workspace-json &optional (authorized "default"))
                 (let ((connection (make-instance 'quasar.ws::ws-connection
                                                  :id "bounded-types" :ws nil
                                                  :session-id "bounded-types" :session-token "bounded-types"
                                                  :principal "bounded-reader"
                                                  :authorized-workspaces (list authorized)
                                                  :capabilities (list command))))
                   (setf response nil reads 0)
                   (quasar.ws::handle-text-message server connection (wire command workspace-json))
                   (loop until response repeat 1000 do (sleep 0.01))
                   (check response)
                   response))
               (response-code ()
                 (quasar.protocol:json-value
                  (quasar.protocol:json-value (jsown:parse response) "error") "code")))
        (unwind-protect
             (progn
               (setf (symbol-function 'quasar.ws::send-connection-text)
                     (lambda (connection encoded) (declare (ignore connection)) (setf response encoded)))
               ;; Count calls but execute the actual Tek9-backed generic methods.
               (dolist (symbol '(quasar.store:workspace-bootstrap quasar.store:search-documents
                                 quasar.store:fetch-document-batch))
                 (let ((original (symbol-function symbol)))
                   (push (cons symbol original) originals)
                   (setf (symbol-function symbol)
                         (lambda (&rest arguments) (incf reads) (apply original arguments)))))
               (dolist (command '("workspace.bootstrap" "document.search" "document.batch"))
                 (dolist (literal '("null" "false" "true" "0" "1" "[]" "{}" "\"\""))
                   (format t "~&Workspace admission regression: ~A workspace=~A~%" command literal)
                   (check (bounded-error-p "protocol.invalid-envelope"
                                           (lambda () (quasar.protocol:decode-command (wire command literal)))))
                   (exchange command literal)
                   (check (equal "protocol.invalid-envelope" (response-code)))
                   (check (zerop reads)))
                 (dolist (literal '("\"NULL\"" "\"FALSE\""))
                   (exchange command literal)
                   (check (equal "security.forbidden" (response-code)))
                   (check (zerop reads)))
                 ;; Omission and an explicit valid string still reach the real store.
                 (dolist (literal '(nil "\"default\""))
                   (exchange command literal)
                   (check (equal "ok" (status response)))
                   (check (= 1 reads)))
                 (dolist (workspace '("NULL" "FALSE"))
                   (exchange command (quasar.protocol:encode workspace) workspace)
                   (check (equal "ok" (status response)))
                   (check (= 1 reads)))))
          (dolist (pair originals) (setf (symbol-function (car pair)) (cdr pair)))
          (setf (symbol-function 'quasar.ws::send-connection-text) send-original)
          (quasar.control-plane:stop-control-plane plane))))))

(defun test-bounded-numeric-filter-continuations ()
  "Oversized filter values cannot make a server cursor its own reader rejects."
  (with-temporary-tek9-store (store path "bounded-numeric-filters")
    (check (probe-file path))
    (seed-bounded-fixture store 3)
    (let ((huge (expt 10 16999)))
      (dolist (pair (list (cons "fields" (quasar.protocol:json-object (cons "n" huge)))
                          (cons "fields" (quasar.protocol:json-object (cons "n" (- huge))))
                          (cons "updatedAfter" huge) (cons "updatedBefore" (- huge))))
        (format t "~&Numeric filter regression: reject oversized ~A~%" (car pair))
        (check (bounded-error-p "query.invalid"
                                (lambda () (bounded-query store pair (cons "scanLimit" 1)))))))
    (let ((fields (cons :obj (loop for index below 16
                                  collect (cons (format nil "f~D" index)
                                                (make-string 256 :initial-element #\\))))))
      (check (bounded-error-p "query.invalid"
                              (lambda () (bounded-query store (cons "fields" fields) (cons "scanLimit" 1))))))
    ;; Large but supported exact integers survive token encoding and re-admission.
    (dolist (pair (list (cons "fields" (quasar.protocol:json-object (cons "n" (expt 10 100))))
                        (cons "updatedAfter" (- (expt 10 100)))
                        (cons "updatedBefore" (expt 10 100))))
      (let ((cursor nil) (complete nil) (pages 0) (seen 0))
        (loop until complete
              while (< pages 8)
              do (let* ((request (quasar.protocol:json-object pair (cons "scanLimit" 1)))
                        (page (progn (when cursor (quasar.protocol:object-set request "cursor" cursor))
                                     (quasar.store:search-documents store "bounded" request))))
                   (incf pages)
                   (incf seen (length (array-elements-for-test (quasar.protocol:json-value page "documents"))))
                   (setf complete (eq t (quasar.protocol:json-value page "complete"))
                         cursor (quasar.protocol:json-value page "cursor"))
                   (unless complete (check (and (stringp cursor) (<= (length cursor) 16000))))))
        (check complete)
        (check (> pages 1))
        (check (= seen (if (string= (car pair) "fields") 0 3)))))
    ;; Even an unusually long stored key must never produce an unusable token.
    (check (bounded-error-p "query.invalid"
                            (lambda () (quasar.store::%search-cursor
                                        "bounded" 0
                                        (quasar.store::%search-scope (quasar.protocol:empty-object))
                                        (make-string 16000 :initial-element #\x)))))))

(defun run-bounded-read-tests ()
  (let ((*failures* 0))
    (test-bounded-reads-and-continuations)
    (test-bounded-query-budgets)
    (test-bounded-command-registration)
    (test-bounded-websocket-authorization)
    (test-bounded-byte-pagination-and-typed-projections)
    (test-bounded-workspace-admission-types)
    (test-bounded-numeric-filter-continuations)
    (when (plusp *failures*) (error "~D bounded-read test checks failed." *failures*))
    t))
