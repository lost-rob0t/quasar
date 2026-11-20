(in-package #:quasar.tests)

;;; starintel.api relay contract (forgejo #142): the client must reach
;;; every star-server fetch/view API even though star-server sends no CORS
;;; headers. The relay exposes a closed read-operation table, forwards only
;;; allowlisted parameters, follows the v1-first/legacy-fallback document
;;; path, and byte-bounds responses like the local document.search. The
;;; relay is fetch/view only: write routes are deliberately absent.

(defvar *relay-calls* nil)

(defun %relay-fake-responder (body status)
  (lambda (url headers)
    (push (list url headers) *relay-calls*)
    (values body status)))

(defmacro %with-fake-dex ((responder) &body forms)
  `(let ((*relay-calls* nil)
         (original (fdefinition 'dex:get)))
     (unwind-protect
          (progn
            (setf (fdefinition 'dex:get)
                  (lambda (url &key headers &allow-other-keys)
                    (funcall ,responder url headers)))
            ,@forms)
       (setf (fdefinition 'dex:get) original))))

(defun %relay-payload (&rest pairs)
  (apply #'quasar.protocol:json-object pairs))

(defun %relay-error-code (thunk)
  (handler-case (funcall thunk)
    (quasar.protocol:quasar-error (condition)
      (quasar.protocol:quasar-error-code condition))
    (:no-error (value)
      (declare (ignore value))
      (format nil "NO-ERROR"))))

(defun test-relay-unknown-op ()
  (check (equal "starintel.unknown-op"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload
                     (cons "url" "http://127.0.0.1:5000")
                     (cons "op" "write-everything"))))))))

(defun test-relay-missing-param ()
  (check (equal "starintel.missing-param"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload
                     (cons "url" "http://127.0.0.1:5000")
                     (cons "op" "document"))))))
         )
  (check (equal "starintel.missing-param"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload
                     (cons "url" "http://127.0.0.1:5000")
                     (cons "op" "targets"))))))))

(defun test-relay-unknown-view ()
  (check (equal "starintel.unknown-view"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload
                     (cons "url" "http://127.0.0.1:5000")
                     (cons "op" "view")
                     (cons "view" "documents/by-secret"))))))))

(defun test-relay-url-validation ()
  (check (equal "starintel.invalid-url"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload
                     (cons "url" "file:///etc/passwd")
                     (cons "op" "stats")))))))
  (check (equal "starintel.invalid-url"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload (cons "op" "stats"))))))))

(defun test-relay-query-allowlist ()
  ;; Only allowlisted parameters reach the wire; empty values and the view
  ;; selector never become query parameters.
  (let ((query (quasar.starintel-relay::%query-string
                "view"
                (%relay-payload
                 (cons "view" "messages/by-user")
                 (cons "user" "alice")
                 (cons "limit" 10)
                 (cons "format" "evil")
                 (cons "token" "secret"))
                (third (assoc "view" quasar.starintel-relay::+read-operations+
                              :test #'string=)))))
    (check (string= query "?user=alice&limit=10"))
    (check (not (search "evil" query)))
    (check (not (search "secret" query)))
    (check (not (search "view" query)))))

(defun test-relay-limit-clamp ()
  (check (equal "starintel.invalid-param"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%query-string
                    "search"
                    (%relay-payload (cons "limit" "not-a-number"))
                    '("limit"))))))
  (let ((query (quasar.starintel-relay::%query-string
                "search"
                (%relay-payload (cons "limit" 10000))
                '("limit"))))
    (check (string= query (format nil "?limit=~A" quasar.starintel-relay::+search-limit-max+))))
  (let ((query (quasar.starintel-relay::%query-string
                "view"
                (%relay-payload (cons "limit" 10000))
                '("limit"))))
    (check (string= query (format nil "?limit=~A" quasar.starintel-relay::+view-limit-max+)))))

(defun test-relay-path-encoding ()
  (check (string= (quasar.starintel-relay::%targets-path
                   (%relay-payload (cons "actor" "youtube actor/2")))
                  "/targets/youtube%20actor%2F2")))

(defun test-relay-happy-path ()
  (let ((payload (%relay-payload
                  (cons "url" "http://127.0.0.1:5000")
                  (cons "token" "sekrit")
                  (cons "op" "search")
                  (cons "q" "document")
                  (cons "limit" 3)
                  (cons "injected" "nope"))))
    (%with-fake-dex ((%relay-fake-responder
                      "{\"total_rows\":2,\"rows\":[],\"bookmark\":\"bm-1\"}" 200))
      (let ((result (quasar.starintel-relay::%starintel-read payload)))
        (check (= 2 (quasar.protocol:json-value result "total_rows")))
        (check (string= "bm-1" (quasar.protocol:json-value result "bookmark")))
        (check (= 1 (length *relay-calls*)))
        (check (string= (first (first *relay-calls*))
                        "http://127.0.0.1:5000/search?q=document&limit=3"))
        (check (equal "Bearer sekrit"
                      (cdr (assoc "Authorization" (second (first *relay-calls*))
                                  :test #'string=)))
               )
        (check (not (search "injected" (first (first *relay-calls*)))))))))

(defun test-relay-legacy-fallback ()
  ;; v1 document route 404s, legacy /document/:id answers.
  (%with-fake-dex
      ((lambda (url headers)
         (declare (ignore headers))
         (push url *relay-calls*)
         (if (search "/api/v1/documents/" url)
             (values "{\"status\":\"error\",\"code\":\"not_found\"}" 404)
             (values "{\"_id\":\"reddit:user:document-dull\"}" 200))))
    (let ((result (quasar.starintel-relay::%starintel-read
                   (%relay-payload
                    (cons "url" "http://127.0.0.1:5000")
                    (cons "op" "document")
                    (cons "id" "reddit:user:document-dull")))))
      (check (string= "reddit:user:document-dull"
                      (quasar.protocol:json-value result "_id")))
      (check (= 2 (length *relay-calls*))))))

(defun test-relay-server-error ()
  (%with-fake-dex ((%relay-fake-responder "{\"status\":\"error\"}" 500))
    (check (equal "starintel.server-error"
                  (%relay-error-code
                   (lambda ()
                     (quasar.starintel-relay::%starintel-read
                      (%relay-payload
                       (cons "url" "http://127.0.0.1:5000")
                       (cons "op" "stats")))))))))

(defun test-relay-invalid-response ()
  (%with-fake-dex ((%relay-fake-responder "<html>not json</html>" 200))
    (check (equal "starintel.invalid-response"
                  (%relay-error-code
                   (lambda ()
                     (quasar.starintel-relay::%starintel-read
                      (%relay-payload
                       (cons "url" "http://127.0.0.1:5000")
                       (cons "op" "stats")))))))))

(defun test-relay-unreachable ()
  ;; A network-level dexador failure becomes starintel.unreachable.
  (let ((original (fdefinition 'dex:get)))
    (unwind-protect
         (progn
           (setf (fdefinition 'dex:get)
                 (lambda (&rest args) (declare (ignore args)) (error "connection refused")))
           (check (equal "starintel.unreachable"
                         (%relay-error-code
                          (lambda ()
                            (quasar.starintel-relay::%starintel-read
                             (%relay-payload
                              (cons "url" "http://127.0.0.1:59999")
                              (cons "op" "stats"))))))))
      (setf (fdefinition 'dex:get) original))))

(defun test-relay-byte-bound ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.starintel-relay:install-starintel-relay-commands plane)
    (let ((handler (gethash "starintel.api"
                            (quasar.control-plane::control-plane-handlers plane))))
      (check (functionp handler))
      (check (member "starintel.api"
                     (quasar.control-plane:control-plane-capabilities plane)
                     :test #'string=))
      (%with-fake-dex ((%relay-fake-responder
                        (format nil "{\"rows\":[~{\"x~A\"~}]}"
                                (loop for i from 0 below 2048 collect i))
                        200))
        (check (equal "query.record-too-large"
                      (%relay-error-code
                       (lambda ()
                         (funcall handler
                                  (%relay-payload
                                   (cons "url" "http://127.0.0.1:5000")
                                   (cons "op" "search")
                                   (cons "byteLimit" 64))
                                  (quasar.protocol:make-command-envelope
                                   :id "relay-1" :command "starintel.api"
                                   :payload (quasar.protocol:empty-object)
                                   :workspace "default"
                                   :client "quasar-tests"))))))
        ;; Without an explicit byteLimit the default budget admits a small page.
        (check
         (consp
          (funcall handler
                   (%relay-payload
                    (cons "url" "http://127.0.0.1:5000")
                    (cons "op" "stats"))
                   (quasar.protocol:make-command-envelope
                    :id "relay-2" :command "starintel.api"
                    :payload (quasar.protocol:empty-object)
                    :workspace "default"
                    :client "quasar-tests"))))))))

(defun test-relay-neighbors ()
  ;; One neighbors call = document fetch + exact-id relation search.
  (let ((payload (%relay-payload
                  (cons "url" "http://127.0.0.1:5000")
                  (cons "op" "neighbors")
                  (cons "id" "reddit:user:document-dull"))))
    (%with-fake-dex
        ((lambda (url headers)
           (declare (ignore headers))
           (push url *relay-calls*)
           (cond
             ((search "/api/v1/documents/reddit%3Auser%3Adocument-dull" url)
              (values "{\"_id\":\"reddit:user:document-dull\",\"dtype\":\"user\"}" 200))
             ((search "/search?q=" url)
              (values (format nil
                              "{\"total_rows\":2,\"rows\":[~A,~A],\"bookmark\":\"bm-rel\"}"
                              "{\"id\":\"reddit:rel:1\",\"doc\":{\"_id\":\"reddit:rel:1\",\"dtype\":\"relation\",\"data\":{\"subject\":{\"id\":\"reddit:user:document-dull\",\"dtype\":\"user\"},\"predicate\":\"authored\",\"object\":{\"id\":\"reddit:1xt5d5m\",\"dtype\":\"social-media-post\"},\"directed\":true}}}"
                              "{\"id\":\"reddit:rel:2\",\"doc\":{\"_id\":\"reddit:rel:2\",\"dtype\":\"relation\",\"data\":{\"subject\":\"reddit:user:friend\",\"predicate\":\"mentions\",\"object\":\"reddit:user:document-dull\",\"directed\":true}}}")
                      200))
             (t (values "{}" 404))))
         )
      (let ((result (quasar.starintel-relay::%starintel-read payload)))
        (check (string= "reddit:user:document-dull"
                        (quasar.protocol:json-value result "id")))
        (check (= 2 (length *relay-calls*)))
        (check (string= "reddit:user:document-dull"
                        (quasar.protocol:json-value
                         (quasar.protocol:json-value result "document") "_id")))
        (let ((relations (quasar.protocol:json-value result "relations")))
          (check (= 2 (length relations)))
          (check (equal '("reddit:rel:1" "subject" "reddit:1xt5d5m" "social-media-post")
                        (list (quasar.protocol:json-value (first relations) "id")
                              (quasar.protocol:json-value (first relations) "direction")
                              (quasar.protocol:json-value (first relations) "neighbor")
                              (quasar.protocol:json-value (first relations) "neighbor_dtype"))))
          (check (equal '("reddit:rel:2" "object" "reddit:user:friend")
                        (list (quasar.protocol:json-value (second relations) "id")
                              (quasar.protocol:json-value (second relations) "direction")
                              (quasar.protocol:json-value (second relations) "neighbor")))))
        (check (string= "bm-rel" (quasar.protocol:json-value result "bookmark")))))))

(defun test-relay-neighbors-missing-param ()
  (check (equal "starintel.missing-param"
                (%relay-error-code
                 (lambda ()
                   (quasar.starintel-relay::%starintel-read
                    (%relay-payload
                     (cons "url" "http://127.0.0.1:5000")
                     (cons "op" "neighbors"))))))))

(defun test-relay-document-not-found ()
  (%with-fake-dex
      ((lambda (url headers)
         (declare (ignore headers))
         (push url *relay-calls*)
         (values "{\"status\":\"error\"}" 404)))
    (check (equal "starintel.not-found"
                  (%relay-error-code
                   (lambda ()
                     (quasar.starintel-relay::%starintel-read
                      (%relay-payload
                       (cons "url" "http://127.0.0.1:5000")
                       (cons "op" "document")
                       (cons "id" "missing:doc"))))))
           )
    (check (= 2 (length *relay-calls*))
           )))

(defun test-relay-documents-recent ()
  ;; Empty-query recents projection: dataset omitted -> global newest-first;
  ;; dataset given -> scoped key range; pagination cursor forwarded.
  (%with-fake-dex ((%relay-fake-responder
                    "{\"total_rows\":2,\"rows\":[],\"next_start_key\":[\"reddit\",1710000000]}"
                    200))
    (let ((result (quasar.starintel-relay::%starintel-read
                   (%relay-payload
                    (cons "url" "http://127.0.0.1:5000")
                    (cons "op" "documents-recent")
                    (cons "limit" 25)
                    (cons "injected" "nope")))))
      (check (string= (first (first *relay-calls*))
                      "http://127.0.0.1:5000/documents/recent?limit=25"))))
  (%with-fake-dex ((%relay-fake-responder "{\"total_rows\":1,\"rows\":[]}" 200))
    (quasar.starintel-relay::%starintel-read
     (%relay-payload
      (cons "url" "http://127.0.0.1:5000")
      (cons "op" "documents-recent")
      (cons "dataset" "progressive-insanity")
      (cons "start_key" "[\"progressive-insanity\",1710000000]")
      (cons "start_key_doc_id" "reddit:nk0g1vw")))
    (check (search "dataset=progressive-insanity"
                   (first (first *relay-calls*))))
    (check (search "startkey=%5B%22progressive-insanity%22%2C1710000000%5D"
                   (first (first *relay-calls*))))
    (check (search "startkey_docid=reddit%3Ank0g1vw"
                   (first (first *relay-calls*))))))

(defun run-starintel-relay-tests ()
  (test-relay-unknown-op)
  (test-relay-missing-param)
  (test-relay-unknown-view)
  (test-relay-url-validation)
  (test-relay-query-allowlist)
  (test-relay-limit-clamp)
  (test-relay-path-encoding)
  (test-relay-happy-path)
  (test-relay-documents-recent)
  (test-relay-legacy-fallback)
  (test-relay-neighbors)
  (test-relay-neighbors-missing-param)
  (test-relay-document-not-found)
  (test-relay-server-error)
  (test-relay-invalid-response)
  (test-relay-unreachable)
  (test-relay-byte-bound))
