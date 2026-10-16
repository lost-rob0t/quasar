(in-package #:quasar.store)

(defgeneric page-documents (store workspace-id request))

(defmethod page-documents ((store workspace-store) workspace-id request)
  (declare (ignore workspace-id request))
  (%query-error "query.unsupported-store" "Document pages require the Tek9 store."))

(defun %document-page-scope ()
  (quasar.protocol:json-object (cons "command" "document.page.v1")))

(defun %document-page-start (database request workspace-id revision prefix)
  ;; Validate shape before delegating to the search cursor's workspace, revision
  ;; and scope checks. Tokens are opaque continuations, not authorization grants.
  (let ((cursor (quasar.protocol:json-value request "cursor" :missing)))
    (unless (eq cursor :missing)
      (unless (and (stringp cursor) (<= (length cursor) *query-max-cursor-characters*))
        (%query-error "query.invalid-cursor" "Invalid document continuation."))
      (let ((token (handler-case (jsown:with-injective-reader (jsown:parse cursor))
                     (error () nil))))
        (unless (quasar.protocol:object-p token)
          (%query-error "query.invalid-cursor" "Malformed document continuation."))))
    (let ((start (%cursor-start request workspace-id revision (%document-page-scope) prefix)))
      (when (and start (not (tek9:fetch* database start)))
        (%query-error "query.invalid-cursor" "Continuation key does not exist."))
      start)))

(defmethod page-documents ((store tek9-store) workspace-id request)
  "Canonical document continuation; no ordinal scan or graph restoration."
  (%query-keys request '("cursor" "limit" "byteLimit"))
  (let* ((limit (%query-integer request "limit" 250 1 *query-max-records*))
         (byte-limit (%query-integer request "byteLimit" *query-max-bytes* 32768 *query-max-bytes*))
         (database (tek9-store-database store))
         (prefix (%document-prefix workspace-id)))
    (tek9:with-read-transaction (database)
      (let* ((revision (quasar.protocol:json-value (%read-meta database workspace-id) "revision" 0))
             (start (%document-page-start database request workspace-id revision prefix))
             (documents nil) (count 0) (bytes 0) (complete nil))
        (loop while (< count limit)
              ;; At most two canonical records decoded by Tek9's inclusive
              ;; range API, retaining only one candidate in addition to the page.
              for row = (first (%bounded-range database prefix :start start :limit 1))
              do (unless row (setf complete t) (return))
                 (let ((size (%utf8-length (quasar.protocol:encode (cdr row)))))
                   ;; Reserve continuation/envelope space; exact response and
                   ;; wire-envelope checks below are still authoritative.
                   (when (> (+ bytes size) (- byte-limit 16384))
                     (unless documents
                       (%query-error "query.record-too-large" "Canonical document exceeds the page budget."))
                     (return))
                   (push (cdr row) documents)
                   (incf count)
                   (incf bytes size)
                   (setf start (car row))))
        (let ((result (quasar.protocol:json-object
                       (cons "revision" revision)
                       (cons "documents" (cons :array (nreverse documents)))
                       (cons "complete" (if complete t :false))
                       (cons "cursor" (if complete :null
                                           (%search-cursor workspace-id revision (%document-page-scope) start))))))
          (when (> (%utf8-length (quasar.protocol:encode result)) byte-limit)
            (%query-error "query.record-too-large" "Document continuation exceeds the page budget."))
          result)))))

(defun stream-document-pages (store workspace-id sink &key (limit 250) (byte-limit *query-max-bytes*))
  "Call SINK synchronously with each canonical document; retain only one page.
Errors propagate, including stale cursors. The sink may already contain a prefix
on failure; callers must discard/abort that export instead of appending a restart."
  (let ((cursor nil) (count 0) (revision nil))
    (loop
      (let* ((request (quasar.protocol:json-object (cons "limit" limit) (cons "byteLimit" byte-limit)))
             (page (progn
                     (when cursor (quasar.protocol:object-set request "cursor" cursor))
                     (page-documents store workspace-id request))))
        (setf revision (quasar.protocol:json-value page "revision"))
        (dolist (document (quasar.workspace:array-elements (quasar.protocol:json-value page "documents")))
          (funcall sink document)
          (incf count))
        (when (eq t (quasar.protocol:json-value page "complete"))
          (return (values count revision)))
        (setf cursor (quasar.protocol:json-value page "cursor"))))))
