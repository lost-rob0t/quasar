(in-package #:quasar.tests)

(defun canonical-page (store &rest pairs)
  (quasar.store:page-documents store "bounded" (apply #'quasar.protocol:json-object pairs)))

(defun test-document-page-contract ()
  (with-temporary-tek9-store (store path "document-pages")
    (check (probe-file path))
    (check (eq t (quasar.protocol:json-value (canonical-page store) "complete")))
    (seed-bounded-fixture store 6 "bounded" 1024)
    (let* ((first (canonical-page store (cons "limit" 3)))
           (cursor (quasar.protocol:json-value first "cursor"))
           (second (canonical-page store (cons "limit" 3) (cons "cursor" cursor)))
           (last (canonical-page store (cons "cursor" (quasar.protocol:json-value second "cursor")))))
      (check (= 3 (length (array-elements-for-test (quasar.protocol:json-value first "documents")))))
      (check (eq :false (quasar.protocol:json-value second "complete")))
      (check (eq t (quasar.protocol:json-value last "complete")))
      (check (eq :null (quasar.protocol:json-value last "cursor")))
      (check (null (array-elements-for-test (quasar.protocol:json-value last "documents"))))
      (check (equal (bounded-fixture-document 0)
                    (first (array-elements-for-test (quasar.protocol:json-value first "documents")))))
      (check (bounded-error-p "query.invalid-cursor"
                              (lambda () (quasar.store:page-documents store "other"
                                           (quasar.protocol:json-object (cons "cursor" cursor))))))
      (check (bounded-error-p "query.invalid-cursor"
                              (lambda () (bounded-query store (cons "cursor" cursor)))))
      (dolist (bad '("null" "[]" "{}" "not-json" :null 1))
        (check (bounded-error-p "query.invalid-cursor"
                                (lambda () (canonical-page store (cons "cursor" bad))))))
      (let ((token (jsown:parse cursor)))
        (quasar.protocol:object-set token "after" (quasar.store::%document-key "bounded" "deleted"))
        (check (bounded-error-p "query.invalid-cursor"
                                (lambda () (canonical-page store (cons "cursor" (quasar.protocol:encode token)))))))
      (let ((database (quasar.store::tek9-store-database store)))
        (tek9:with-write-transaction (database)
          (quasar.store::%put-record database (quasar.store::%workspace-meta-key "bounded")
                                    (quasar.store::%default-workspace-meta "bounded" 2 6))))
      (check (bounded-error-p "query.stale-cursor"
                              (lambda () (canonical-page store (cons "cursor" cursor)))))))
  (with-temporary-tek9-store (store path "document-page-bytes")
    (check (probe-file path))
    (seed-bounded-fixture store 12 "bounded" 9000)
    (let ((count 0))
      (with-bounded-read-instrumentation
       (lambda ()
         (check (= 12 (quasar.store:stream-document-pages
                       store "bounded" (lambda (document) (declare (ignore document)) (incf count))
                       :byte-limit 32768)))))
      (check (= count 12)))
    (seed-bounded-fixture store 1 "oversized" 40000)
    (check (bounded-error-p "query.record-too-large"
                            (lambda () (quasar.store:page-documents store "oversized"
                                         (quasar.protocol:json-object (cons "byteLimit" 32768))))))
    ;; Wire overhead is checked independently, including escaped request IDs.
    (let ((envelope (quasar.protocol:decode-command
                     (make-envelope "document.page" (quasar.protocol:empty-object) :workspace "bounded"))))
      (check (bounded-error-p "query.record-too-large"
                              (lambda () (quasar.control-plane::bounded-wire-result
                                           (canonical-page store) envelope 10)))))
    ;; A mutation in a streaming sink must prevent combining revisions.
    (let ((seen 0))
      (check (bounded-error-p
              "query.stale-cursor"
              (lambda ()
                (quasar.store:stream-document-pages
                 store "bounded"
                 (lambda (document)
                   (declare (ignore document))
                   (incf seen)
                   (let ((database (quasar.store::tek9-store-database store)))
                     (tek9:with-write-transaction (database)
                       (quasar.store::%put-record database (quasar.store::%workspace-meta-key "bounded")
                                                 (quasar.store::%default-workspace-meta "bounded" 2 12)))))
                 :limit 1))))
      (check (= seen 1)))))

(defun test-document-page-linear-traversal ()
  (dolist (count '(10000 100000))
    (with-temporary-tek9-store (store path "document-page-linear")
      (check (probe-file path))
      (seed-bounded-fixture store count "bounded" 256)
      (let ((original (symbol-function 'tek9:select-primary-range))
            (calls 0) (rows 0) (seen 0) (last-key nil)
            (allocated-before (sb-ext:get-bytes-consed)))
        (unwind-protect
             (progn
               (setf (symbol-function 'tek9:select-primary-range)
                     (lambda (database start &rest options &key limit &allow-other-keys)
                       (check (and (integerp limit) (<= limit 2)))
                       ;; Every actual Tek9 seek advances or repeats a boundary;
                       ;; a late page must never reset to the prefix.
                       (when last-key (check (not (string< start last-key))))
                       (setf last-key start)
                       (incf calls)
                       (let ((result (apply original database start options)))
                         (incf rows (length result)) result)))
               (check (= count (quasar.store:stream-document-pages
                                store "bounded"
                                (lambda (document)
                                  (check (string= (quasar.protocol:json-value document "id")
                                                  (format nil "bounded:~8,'0D" seen)))
                                  (incf seen)))))
               (check (= seen count))
               (check (<= calls (+ count 1)))
               (check (<= rows (+ (* 2 count) 2)))
               (format t "~&Document page traversal: corpus=~D calls=~D decoded-range-rows=~D allocated=~D~%"
                       count calls rows (- (sb-ext:get-bytes-consed) allocated-before)))
          (setf (symbol-function 'tek9:select-primary-range) original))))))

(defun test-document-page-variable-records ()
  (with-temporary-tek9-store (store path "document-page-variable")
    (check (probe-file path))
    (let ((database (quasar.store::tek9-store-database store)) (expected nil) (seen nil))
      (tek9:with-write-transaction (database)
        (loop for id in '("z" "aa" "a" "longer-id")
              for size in '(10 12000 14000 30)
              for index from 0
              for document = (bounded-fixture-document index size)
              do (quasar.protocol:object-set document "id" id)
                 (push (cons (quasar.store::%document-key "bounded" id) id) expected)
                 (quasar.store::%put-record database (quasar.store::%document-key "bounded" id) document))
        (quasar.store::%put-record database (quasar.store::%workspace-meta-key "bounded")
                                  (quasar.store::%default-workspace-meta "bounded" 1 4)))
      (check (= 4 (quasar.store:stream-document-pages
                    store "bounded" (lambda (document) (push (quasar.protocol:json-value document "id") seen))
                    :byte-limit 32768)))
      (check (equal (nreverse seen) (mapcar #'cdr (sort expected #'string< :key #'car)))))))

(defun test-document-page-memory ()
  (let ((small nil) (large nil))
    (dolist (count '(10000 100000))
      (with-temporary-tek9-store (store path "document-page-memory")
        (check (probe-file path))
        (seed-bounded-fixture store count "bounded" 256)
        (canonical-page store (cons "limit" 50))
        (sb-ext:gc :full t)
        (let ((before (sb-ext:get-bytes-consed)) (heap (sb-kernel:dynamic-usage)) (page nil))
          (with-bounded-read-instrumentation
           (lambda () (setf page (canonical-page store (cons "limit" 50)))))
          (let ((allocated (- (sb-ext:get-bytes-consed) before)))
            (sb-ext:gc :full t)
            (let ((retained (- (sb-kernel:dynamic-usage) heap)))
              (check (= 50 (length (array-elements-for-test (quasar.protocol:json-value page "documents")))))
              (check (< allocated (* 8 1024 1024)))
              (check (< retained (* 512 1024)))
              (if small (setf large allocated) (setf small allocated))
              (format t "~&Document page memory: corpus=~D allocated=~D retained=~D~%" count allocated retained))))))
    (check (< large (+ (* 2 small) (* 64 1024))))))

(defun run-document-page-tests ()
  (let ((*failures* 0))
    (test-document-page-contract)
    (test-document-page-variable-records)
    (test-document-page-memory)
    (test-document-page-linear-traversal)
    (when (plusp *failures*) (error "~D document-page checks failed." *failures*))
    t))
