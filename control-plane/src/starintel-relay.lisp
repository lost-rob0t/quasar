(in-package #:quasar.starintel-relay)

;;; Relay for StarIntel server integration probes.
;;;
;;; The browser cannot fetch the StarIntel server directly: star-server does
;;; not emit CORS headers, so Settings > Test server connection always fails
;;; with "Failed to fetch" regardless of credentials. The control plane
;;; performs the HTTP probe server-side (dexador) and returns the same
;;; {mode, capabilities} shape the frontend used to build locally. Auth is
;;; delegated: whatever token the operator stores is forwarded as a Bearer
;;; header; servers without auth ignore it.

(defun %relay-error (code message)
  (error 'quasar-error :code code :message message))

(defun %relay-base-url (payload)
  (let* ((raw (string-trim " " (or (json-value payload "url") "")))
         (base (string-right-trim "/" raw)))
    (when (zerop (length base))
      (%relay-error "starintel.invalid-url" "StarIntel server URL is required."))
    (unless (or (uiop:string-prefix-p "http://" base)
                (uiop:string-prefix-p "https://" base))
      (%relay-error "starintel.invalid-url"
                    "StarIntel server URL must use http:// or https://."))
    base))

(defun %relay-headers (token)
  (if (and token (plusp (length (string-trim " " token))))
      (list (cons "Authorization" (format nil "Bearer ~A" (string-trim " " token)))
            (cons "Accept" "application/json"))
      (list (cons "Accept" "application/json"))))

(defun %relay-get-json (url token)
  "Fetch URL and parse the body as JSON; returns (VALUES json status)."
  (multiple-value-bind (body status)
      (dex:get url :headers (%relay-headers token)
               :connect-timeout 5 :read-timeout 10)
    (values (jsown:parse (or body "")) status)))

(defun %probe-legacy (base token)
  (multiple-value-bind (body status)
      (%relay-get-json (format nil "~A/" base) token)
    (when (>= status 400)
      (%relay-error
       "starintel.unreachable"
       (format nil "StarIntel server probe failed (legacy / returned ~A)." status)))
    (json-object
     (cons "mode" "legacy")
     (cons "capabilities"
           (json-object
            (cons "schemaRevision" (or (json-value body "doc_spec_version") "legacy"))
            (cons "dataset" (or (json-value body "default-dataset") "default"))
            (cons "endpoints"
                  (json-object
                   (cons "submitTarget" "/new/target/:actor")
                   (cons "submitDocument" "/new/document/:dtype")
                   (cons "search" "/search"))))))))

(defun %probe (base token)
  ;; v1 capability endpoint first, legacy gserver root as fallback — the same
  ;; contract the removed browser-side probe implemented.
  (handler-case
      (let ((capabilities (nth-value 0 (%relay-get-json
                                        (format nil "~A/api/v1/capabilities" base) token))))
        (json-object (cons "mode" "v1")
                     (cons "capabilities" capabilities)))
    (error (condition)
      (declare (ignore condition))
      (%probe-legacy base token))))

(defun %relay-json-array (items)
  ;; quasar.protocol:json-array is &rest; build a tagged :array from a list.
  (cons :array items))

;;; --- Read operations (forgejo #142) -------------------------------------
;;;
;;; Every star-server API that can fetch or view data must be reachable by
;;; the client. Neither star-server nor Forgejo emits CORS headers, so all
;;; of them relay through this single bounded command: starintel.api picks
;;; one operation from a closed table, forwards only allowlisted query
;;; parameters, and byte-bounds the response like the local document.search.

(defparameter +read-operation-response-max-bytes+ (* 512 1024)
  "Response byte budget, matching the local quasar.store:*query-max-bytes*
bounded-read budget.")

(defparameter +search-limit-max+ 100)
(defparameter +view-limit-max+ 200)

;; op name -> path template + allowlisted query parameters. Write routes
;; (POST/PATCH/PUT/DELETE) are deliberately absent: this relay is
;; fetch/view only; mutations stay local via the workspace commands.
(defparameter +read-operations+
  '(("search"       "/search"                ("q" "limit" "bookmark" "sort"))
    ("stats"        "/api/v1/stats"          nil)
    ("actors"       "/v1/actors"             nil)
    ("document"     nil                      nil)
    ("neighbors"    nil                      ("id" "limit" "bookmark"))
    ("targets"      nil                      nil)
    ("view"         nil                      ("user" "platform" "channel" "group"
                                              "limit" "descending" "skip"
                                              "start_key" "end_key" "reduce"
                                              "include_docs"))
    ("dataset-size" "/dataset-size"          nil))
  "Every star-server read (fetch/view) endpoint, per the v1 capabilities
endpoint list. starintel.probe already covers /api/v1/capabilities.
document and neighbors compose server calls (v1 + legacy fallback, or
document + relation search); the rest are single GETs.")

;; view name -> path + key parameter name (nil when the view is unkeyed;
;; by-channel takes both channel and group from the common parameters).
(defparameter +view-operations+
  '(("messages/by-user"               "/documents/messages/by-user"               "user")
    ("messages/by-platform"           "/documents/messages/by-platform"           "platform")
    ("messages/by-channel"            "/documents/messages/by-channel"            nil)
    ("messages/groups"                "/documents/messages/groups"                nil)
    ("social-media-posts/by-user"     "/documents/social-media-posts/by-user"     "user")
    ("social-media-posts/by-group"    "/documents/social-media-posts/by-group"    "group")
    ("social-media-posts/by-platform" "/documents/social-media-posts/by-platform" "platform")))

(defparameter +neighbors-default-limit+ 25
  "Relations returned per neighbors request; paged through the search
bookmark beyond that.")

(defun %read-operation (op)
  (let ((entry (assoc op +read-operations+ :test #'string=)))
    (unless entry
      (%relay-error "starintel.unknown-op"
                    (format nil "Unknown StarIntel read operation ~S. Known operations: search, stats, actors, document, neighbors, targets, view, dataset-size."
                            (or op ""))))
    entry))

(defun %param-text (payload name)
  ;; A present-but-empty parameter is treated as absent.
  (let ((value (json-value payload name)))
    (if (and value (not (equal value "")))
        (format nil "~A" value)
        nil)))

(defun %clamped-limit (op raw)
  (let ((max (if (string= op "view") +view-limit-max+ +search-limit-max+))
        (number (ignore-errors (parse-integer raw))))
    (unless number
      (%relay-error "starintel.invalid-param"
                    (format nil "Parameter limit must be an integer, got ~S." raw)))
    (max 1 (min number max))))

(defun %query-string (op payload allowed)
  (let ((pairs '()))
    (dolist (name allowed)
      (unless (string= name "view") ; selects the path, never a query param
        (let ((raw (json-value payload name)))
          (when (and raw (not (equal raw "")))
            (let ((text (format nil "~A" raw)))
              (when (string= name "limit")
                (setf text (format nil "~A" (%clamped-limit op text))))
              (push (format nil "~A=~A"
                            (quri:url-encode name)
                            (quri:url-encode text))
                    pairs))))))
    (when pairs
      (format nil "?~{~A~^&~}" (nreverse pairs)))))

(defun %targets-path (payload)
  (let ((actor (%param-text payload "actor")))
    (unless actor
      (%relay-error "starintel.missing-param" "Parameter actor is required."))
    (format nil "/targets/~A" (quri:url-encode actor))))

(defun %view-path (payload)
  (let* ((view (%param-text payload "view"))
         (entry (and view (assoc view +view-operations+ :test #'string=))))
    (unless entry
      (%relay-error
       "starintel.unknown-view"
       (format nil "Unknown StarIntel view ~S. Known:~{ ~A~}."
               (or view "")
               (mapcar #'first +view-operations+))))
    (values (second entry) (third entry))))

(defun %read-request (op payload)
  "Returns (VALUES path query-string) for single-GET operations."
  (let ((entry (assoc op +read-operations+ :test #'string=)))
    (cond
      ((string= op "targets")
       (values (%targets-path payload) nil))
      ((string= op "view")
       (multiple-value-bind (view-path key-param) (%view-path payload)
         (declare (ignore key-param))
         (values view-path (%query-string op payload (third entry)))))
      (t
       (values (second entry) (%query-string op payload (third entry)))))))

(defun %read-fetch (url token)
  "GET URL and return (VALUES body status); network failures become
starintel.unreachable."
  (handler-case
      (dex:get url :headers (%relay-headers token)
               :connect-timeout 5 :read-timeout 15)
    (error (condition)
      (%relay-error "starintel.unreachable"
                    (format nil "Could not reach StarIntel server at ~A: ~A"
                            url condition)))))

(defun %parse-json-object (body label)
  ;; jsown is a lenient parser: a non-JSON body can parse into something
  ;; scalar without signaling. Every relayed endpoint returns a JSON
  ;; object, so require the (:obj . pairs) shape.
  (let ((parsed (handler-case (jsown:parse (or body ""))
                  (error () nil))))
    (unless (and (consp parsed) (eq (first parsed) :obj))
      (%relay-error "starintel.invalid-response"
                    (format nil "StarIntel server returned a non-JSON body for ~A." label)))
    parsed))

(defun %fetch-json (url token)
  "GET URL expecting a JSON object; non-2xx and non-JSON are relay errors."
  (multiple-value-bind (body status)
      (%read-fetch url token)
    (when (>= status 400)
      (%relay-error "starintel.server-error"
                    (format nil "StarIntel server returned ~A for ~A." status url)))
    (%parse-json-object body url)))

(defun %single-fetch-read (op payload)
  "Execute one single-GET read operation."
  (let* ((token (json-value payload "token"))
         (base (%relay-base-url payload)))
    (multiple-value-bind (path query) (%read-request op payload)
      (%fetch-json (format nil "~A~A~A" base path (or query "")) token))))

(defun %fetch-document-json (base token id)
  "Fetch one document: v1 route first, legacy /document/:id as the 404
fallback (the probe's v1-first/legacy-fallback contract). Returns NIL
when both routes answer 404."
  (let ((encoded (quri:url-encode id)))
    (multiple-value-bind (body status)
        (%read-fetch (format nil "~A/api/v1/documents/~A" base encoded) token)
      (when (= status 404)
        (multiple-value-bind (legacy-body legacy-status)
            (%read-fetch (format nil "~A/document/~A" base encoded) token)
          (if (= legacy-status 404)
              (return-from %fetch-document-json nil)
              (setf body legacy-body status legacy-status))))
      (when (>= status 400)
        (%relay-error "starintel.server-error"
                      (format nil "StarIntel server returned ~A for document ~A."
                              status id)))
      (%parse-json-object body (format nil "document ~A" id)))))

(defun %endpoint-id (value)
  "Relation endpoints are either bare document ids or nested {id, dtype}
objects, depending on the server projection. Returns the id string or NIL."
  (cond ((stringp value) value)
        ((and (consp value) (eq (first value) :obj))
         (let ((id (json-value value "id")))
           (and id (stringp id) id)))
        (t nil)))

(defun %endpoint-dtype (value)
  (and (consp value) (eq (first value) :obj)
       (let ((dtype (json-value value "dtype")))
         (and dtype (stringp dtype) dtype))))

(defun %relation-entry (row document-id)
  "Derive one typed relation entry from a search row whose document is a
relation record referencing DOCUMENT-ID as subject or object. NIL when the
row is not a relation pointing at the document."
  (let* ((doc (json-value row "doc"))
         (data (and doc (json-value doc "data")))
         (raw-subject (and data (json-value data "subject")))
         (raw-object (and data (json-value data "object")))
         (subject (and data (%endpoint-id raw-subject)))
         (object (and data (%endpoint-id raw-object))))
    (cond
      ((and subject (string= subject document-id))
       (json-object
        (cons "id" (json-value row "id"))
        (cons "predicate" (or (json-value data "predicate") ""))
        (cons "direction" "subject")
        (cons "neighbor" object)
        (cons "neighbor_dtype" (or (%endpoint-dtype raw-object) ""))
        (cons "directed" (json-value data "directed" nil))))
      ((and object (string= object document-id))
       (json-object
        (cons "id" (json-value row "id"))
        (cons "predicate" (or (json-value data "predicate") ""))
        (cons "direction" "object")
        (cons "neighbor" subject)
        (cons "neighbor_dtype" (or (%endpoint-dtype raw-subject) ""))
        (cons "directed" (json-value data "directed" nil)))))))

(defun %neighbors-read (payload)
  "One call: the document plus its neighbors. Neighbors come from the
server FTS on the exact id, which matches the relation documents pointing
at it; each relation entry carries the relation id, predicate, direction,
and the neighbor document id, so the UI fetches a neighbor with a single
follow-up document call. Bounded: relations default to
+neighbors-default-limit+ per request and page through the search bookmark."
  (let* ((token (json-value payload "token"))
         (base (%relay-base-url payload))
         (id (%param-text payload "id")))
    (unless id
      (%relay-error "starintel.missing-param" "Parameter id is required."))
    (let* ((limit (if (json-value payload "limit")
                      (%clamped-limit "search"
                                      (format nil "~A" (json-value payload "limit")))
                      +neighbors-default-limit+))
           (bookmark (json-value payload "bookmark"))
           (document (ignore-errors (%fetch-document-json base token id)))
           (response (%fetch-json
                      (format nil "~A/search?q=~A&limit=~A~A"
                              base
                              (quri:url-encode (format nil "\"~A\"" id))
                              limit
                              (if bookmark
                                  (format nil "&bookmark=~A"
                                          (quri:url-encode (format nil "~A" bookmark)))
                                  ""))
                      token))
           (relations
             (loop for row in (or (json-value response "rows" nil))
                   for entry = (%relation-entry row id)
                   when entry collect entry))
           (pairs (list (cons "id" id)
                        (cons "total_relations" (json-value response "total_rows" 0))
                        ;; jsown-native plain list: encodes as a JSON array
                        ;; and reads back without the encoder tag.
                        (cons "relations" relations))))
      (when document
        (push (cons "document" document) pairs))
      (let ((response-bookmark (json-value response "bookmark" nil)))
        (when response-bookmark
          (push (cons "bookmark" response-bookmark) pairs)))
      (apply #'json-object pairs))))

(defun %starintel-read (payload)
  "Execute one read operation and return the parsed JSON response."
  (let ((op (first (%read-operation (json-value payload "op")))))
    (cond
      ((string= op "neighbors") (%neighbors-read payload))
      ((string= op "document")
       (let* ((token (json-value payload "token"))
              (base (%relay-base-url payload))
              (id (or (%param-text payload "id")
                      (%relay-error "starintel.missing-param"
                                    "Parameter id is required."))))
         (or (%fetch-document-json base token id)
             (%relay-error "starintel.not-found"
                           (format nil "No document ~A on the StarIntel server." id)))))
      (t (%single-fetch-read op payload)))))

(defun %install-starintel-api-command (plane)
  (register-command
   plane
   "starintel.api"
   (lambda (payload envelope)
     (bounded-wire-result
      (%starintel-read payload)
      envelope
      (json-value payload "byteLimit" +read-operation-response-max-bytes+)))))

(defun install-starintel-relay-commands (plane)
  (register-command
   plane
   "starintel.probe"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (let ((token (json-value payload "token"))
           (base (%relay-base-url payload)))
       (handler-case
           (%probe base token)
         (quasar-error (condition) (error condition))
         (error (condition)
           (%relay-error
            "starintel.unreachable"
            (format nil "Could not reach StarIntel server at ~A: ~A"
                    base condition)))))))
  (register-command
   plane
   "starintel.registry"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (let* ((token (json-value payload "token"))
            (url (or (json-value payload "url")
                     "https://git.starintel.actor/api/v1/repos/starintel-labs/starintel-pro-actors/raw/registry/actors.jsonl?ref=registry/actors"))
            (text (nth-value 0 (dex:get url :headers (%relay-headers token)
                                        :connect-timeout 5 :read-timeout 15)))
            (actors
              (loop for line in (uiop:split-string text :separator '(#\Newline))
                    for trimmed = (string-trim " " line)
                    for index from 0
                    when (plusp (length trimmed))
                      collect (progn
                                (when (>= index 200)
                                  (%relay-error "registry.too-large"
                                                "Actor registry exceeds 200 entries."))
                                (jsown:parse trimmed)))))
       (%relay-json-array actors))))
  (%install-starintel-api-command plane)
  plane)
