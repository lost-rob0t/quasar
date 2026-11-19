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
  plane)
