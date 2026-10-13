(in-package #:quasar.tests)

(defun benchmark-process-memory ()
  (let ((fields (quasar.protocol:empty-object)))
    (dolist (line (uiop:read-file-lines "/proc/self/status"))
      (dolist (name '("VmRSS" "VmHWM" "RssAnon" "RssFile"))
        (when (uiop:string-prefix-p (concatenate 'string name ":") line)
          (quasar.protocol:object-set fields name
                                      (* 1024 (parse-integer line :start (1+ (length name)) :junk-allowed t))))))
    fields))

(defun measure-bounded-operation (label thunk)
  (sb-ext:gc :full t)
  (let ((heap-before (sb-kernel:dynamic-usage))
        (allocated-before (sb-ext:get-bytes-consed))
        (began (get-internal-real-time))
        (rss-before (benchmark-process-memory)))
    (let* ((value (funcall thunk))
           (elapsed (ceiling (* 1000 (- (get-internal-real-time) began)) internal-time-units-per-second))
           (allocation (- (sb-ext:get-bytes-consed) allocated-before))
           (heap-before-gc (sb-kernel:dynamic-usage))
           (rss (benchmark-process-memory))
           (bytes (if (and (quasar.protocol:object-p value)
                           (not (string= label "legacy-snapshot-drain")))
                      (quasar.store::%utf8-length (quasar.protocol:encode value)) 0)))
      (sb-ext:gc :full t)
      (let ((retained (sb-kernel:dynamic-usage)))
        ;; Keep VALUE alive through the post-GC retained-heap observation.
        (assert value)
        (quasar.protocol:json-object
         (cons "operation" label) (cons "elapsedMs" elapsed) (cons "allocatedBytes" allocation)
         (cons "heapBefore" heap-before) (cons "heapBeforeGc" heap-before-gc)
         (cons "retainedHeapDelta" (- retained heap-before))
         (cons "pageFetches" (quasar.protocol:json-value value "pages" :null))
         (cons "transferBytes" (quasar.protocol:json-value value "transferBytes" :null))
         (cons "responseBytes" bytes) (cons "processBefore" rss-before) (cons "processAfter" rss))))))

(defun run-bounded-read-benchmark ()
  (let* ((count (parse-integer (or (uiop:getenv "QUASAR_BENCH_DOCUMENTS") "10000")))
         (path (unique-tek9-test-path "bounded-benchmark"))
         (store nil) (metrics nil))
    (unwind-protect
         (progn
           (setf store (quasar.store:make-tek9-store :path path))
           (seed-bounded-fixture store count "bounded" 256)
           (quasar.store:close-store store)
           (setf store (quasar.store:make-tek9-store :path path))
           (push (measure-bounded-operation "bootstrap"
                                            (lambda () (quasar.store:workspace-bootstrap store "bounded"))) metrics)
           (push (measure-bounded-operation "search-50"
                                            (lambda () (bounded-query store))) metrics)
           (push (measure-bounded-operation "missing-search-scan-budget"
                                            (lambda () (bounded-query store (cons "q" "not-present")))) metrics)
           (let ((range-calls 0))
             (setf range-calls (with-bounded-read-instrumentation
                                (lambda () (dotimes (i 10) (bounded-query store)))))
             (push (quasar.protocol:json-object (cons "operation" "ten-searches-call-guard")
                                                (cons "rangeCalls" range-calls) (cons "recordsPerSearch" 50)) metrics))
           (push (measure-bounded-operation "ten-searches"
                                            (lambda () (loop repeat 10 for page = (bounded-query store) finally (return page)))) metrics)
           (push (measure-bounded-operation
                  "legacy-snapshot-drain"
                  (lambda ()
                    (let ((offset 0) (documents nil) (pages 0) (transfer 0) (done nil))
                      (loop until done
                            do (let* ((snapshot (quasar.store:direct-workspace-snapshot-page
                                                 store "bounded" offset (* 512 1024)))
                                      (page (quasar.protocol:json-value snapshot "documentPage")))
                                 (incf pages)
                                 (incf transfer (quasar.store::%utf8-length (quasar.protocol:encode snapshot)))
                                 (dolist (document (array-elements-for-test (quasar.protocol:json-value snapshot "documents")))
                                   (push document documents))
                                 (setf offset (quasar.protocol:json-value page "nextOffset")
                                       done (eq t (quasar.protocol:json-value page "complete")))))
                      (quasar.protocol:json-object
                       (cons "documents" (cons :array documents)) (cons "pages" pages)
                       (cons "transferBytes" transfer))))) metrics)
           (push (measure-bounded-operation "legacy-load-and-copy"
                                            (lambda () (quasar.workspace:copy-workspace
                                                        (quasar.store:load-workspace store "bounded")))) metrics)
           (format t "~&BOUNDED-BENCHMARK ~A~%"
                   (quasar.protocol:encode
                    (quasar.protocol:json-object
                     (cons "documents" count) (cons "bodyBytes" 256)
                     (cons "lisp" (lisp-implementation-version))
                     (cons "metrics" (cons :array (nreverse metrics)))))))
      (when store (quasar.store:close-store store))
      (when (probe-file path) (uiop:delete-directory-tree path :validate t)))))

(defun run-bounded-memory-tests ()
  (let ((*failures* 0) (small nil) (large nil))
    (dolist (count '(10000 100000))
      (with-temporary-tek9-store (store path "bounded-memory-gate")
        (check (probe-file path))
        (seed-bounded-fixture store count "bounded" 256)
        (quasar.store:close-store store)
        (setf store (quasar.store:make-tek9-store :path path))
        (bounded-query store)
        (sb-ext:gc :full t)
        (let ((allocated-before (sb-ext:get-bytes-consed))
              (heap-before (sb-kernel:dynamic-usage))
              (page nil))
          (with-bounded-read-instrumentation
           (lambda () (setf page (bounded-query store))))
          (let ((allocated (- (sb-ext:get-bytes-consed) allocated-before)))
            (sb-ext:gc :full t)
            (let ((retained (- (sb-kernel:dynamic-usage) heap-before)))
              (check (= 50 (length (array-elements-for-test (quasar.protocol:json-value page "documents")))))
              (check (< allocated (* 8 1024 1024)))
              (check (< retained (* 512 1024)))
              (if small (setf large allocated) (setf small allocated))
              (format t "~&Bounded memory gate: documents=~D page=50 allocated=~D retained=~D bytes~%"
                      count allocated retained))))))
    (check (< large (+ (* 2 small) (* 64 1024))))
    (when (plusp *failures*) (error "~D bounded-memory checks failed." *failures*))
    t))
