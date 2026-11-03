(in-package #:quasar.tests)

;;; Python actor runner tests. Hermetic: the executor seam on the control
;;; plane replaces the subprocess with canned JSONL output. The live lane
;;; (real checkout, real Melissa key) is opt-in via
;;; QUASAR_PYTHON_ACTORS_LIVE=1.

(defun fake-python-actor-executor (stdout &optional (exit 0) (stderr ""))
  (lambda (python arguments checkout environment timeout)
    (declare (ignore python arguments checkout environment timeout))
    (values stdout stderr exit)))

(defun use-fake-python-actor-executor (plane stdout &optional (exit 0) (stderr ""))
  (setf (quasar.control-plane::control-plane-python-actors-executor plane)
        (fake-python-actor-executor stdout exit stderr)))

(defun python-actor-observation-document (observer)
  (jsown:parse
   (jsown:to-json
    (quasar.protocol:json-object
     (cons "id" (format nil "starintel:observation:~A:test" observer))
     (cons "dataset" "quasar-python-actors")
     (cons "dtype" "observation")
     (cons "schemaVersion" "0.10.1")
     (cons "observationType" "provider-lookup")
     (cons "observerId" observer)
     (cons "observedProperty" "lookup")
     (cons "value" observer)))))

(defun call-command-async (plane encoded &key (timeout 20))
  "python-actors.run replies from its own thread; poll for the reply."
  (let ((box (cons nil nil)))
    (quasar.control-plane:submit-command
     plane encoded
     (lambda (response) (setf (car box) response)))
    (loop for i below (* timeout 100)
          until (car box)
          do (sleep 0.01)
          finally (return (or (car box)
                              (format nil "{\"status\":\"timeout\"}"))))))

(defun python-actor-run-response (plane actor target &key options)
  (call-command-async
   plane
   (make-envelope
    "python-actors.run"
    (quasar.protocol:json-object
     (cons "actor" actor)
     (cons "target" target)
     (cons "options" options))
    :workspace "python-actors")))

(defun parsed-response-result (response)
  (jsown:val (jsown:parse response) "result"))

(defun test-python-actor-dotenv-parsing ()
  (let ((entries
          (quasar.control-plane::python-actors-parse-dotenv
           "# comment line
STARINTEL_MELISSA_LICENSE_KEY=abc123
RABBITMQ_HOST=rabbitmq

EMPTY=")))
    (check (= 2 (length entries)))
    (check (string= (cdr (assoc "STARINTEL_MELISSA_LICENSE_KEY" entries
                                 :test #'string=))
                     "abc123"))
    (check (string= (cdr (assoc "RABBITMQ_HOST" entries :test #'string=))
                     "rabbitmq"))))

(defun test-python-actor-target-document-shape ()
  (let* ((target
           (quasar.control-plane::python-actors-target-document
            "melissa" "John Doe"
            (jsown:parse "{\"service\":\"global-email\"}")))
         (options (quasar.protocol:json-value target "options")))
    (check (string= (quasar.protocol:json-value target "dtype") "target"))
    (check (string= (quasar.protocol:json-value target "schemaVersion") "0.10.1"))
    (check (string= (quasar.protocol:json-value target "actor") "melissa"))
    (check (string= (quasar.protocol:json-value target "target") "John Doe"))
    (check (string= (quasar.protocol:json-value options "service") "global-email"))))

(defun test-python-actor-checkout-override ()
  (let ((previous (uiop:getenv "QUASAR_PRO_ACTORS_PATH")))
    (unwind-protect
         (progn
           (setf (uiop:getenv "QUASAR_PRO_ACTORS_PATH") "/definitely/not/a/checkout")
           (check (null (quasar.control-plane::python-actors-checkout))))
      (if previous
          (setf (uiop:getenv "QUASAR_PRO_ACTORS_PATH") previous)
          (setf (uiop:getenv "QUASAR_PRO_ACTORS_PATH") "")))))

(defun test-python-actor-capabilities-advertised ()
  (check (member "python-actors.status" quasar.ws::+default-capabilities+
                 :test #'string=))
  (check (member "python-actors.run" quasar.ws::+default-capabilities+
                 :test #'string=)))

(defun test-python-actor-run-ingests-documents ()
  (let ((plane (quasar.control-plane:make-control-plane))
        (stdout
          (concatenate
           'string
           (jsown:to-json (python-actor-observation-document "global-ip"))
           (string #\Newline)
           (jsown:to-json (python-actor-observation-document "global-email"))
           (string #\Newline))))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-python-actor-commands plane)
           (use-fake-python-actor-executor plane stdout)
           (let ((response
                   (python-actor-run-response
                    plane "melissa" "8.8.8.8"
                    :options (jsown:parse "{\"service\":\"global-ip\"}"))))
             (check (string= (status response) "ok"))
             (let ((result (parsed-response-result response)))
               (check (= 2 (quasar.protocol:json-value result "count")))
               (check (= 2 (quasar.protocol:json-value result "created")))
               (check (= 0 (quasar.protocol:json-value result "updated")))))
           ;; Re-running the same actor output updates instead of duplicating.
           (let ((response (python-actor-run-response plane "melissa" "8.8.8.8")))
             (check (string= (status response) "ok"))
             (let ((result (parsed-response-result response)))
               (check (= 2 (quasar.protocol:json-value result "count")))
               (check (= 0 (quasar.protocol:json-value result "created")))
               (check (= 2 (quasar.protocol:json-value result "updated"))))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-python-actor-run-maps-subprocess-failure ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-python-actor-commands plane)
           (use-fake-python-actor-executor plane "" 1 "boom")
           (let ((response (python-actor-run-response plane "melissa" "x")))
             (check (string= (status response) "error"))
             (check (string= (error-code response) "python-actors.actor-failed"))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-python-actor-run-rejects-invalid-payloads ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-python-actor-commands plane)
           (use-fake-python-actor-executor plane "")
           (let ((response (python-actor-run-response plane "" "x")))
             (check (string= (status response) "error"))
             (check (string= (error-code response)
                             "python-actors.invalid-target")))
           (let ((response (python-actor-run-response plane "melissa" "")))
             (check (string= (status response) "error"))
             (check (string= (error-code response)
                             "python-actors.invalid-target"))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-python-actor-status-lists-actors ()
  (let ((plane (quasar.control-plane:make-control-plane))
        (listing
          (format nil "melissa~AContact/data enrichment lookups~Abluesky~ABluesky collector~%"
                  #\Tab #\Newline #\Tab)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-python-actor-commands plane)
           (use-fake-python-actor-executor plane listing)
           (let ((response
                   (call-command
                    plane
                    (make-envelope "python-actors.status"
                                   (quasar.protocol:empty-object)
                                   :workspace "python-actors"))))
             (check (string= (status response) "ok"))
             (let ((result (parsed-response-result response)))
               (check (quasar.protocol:json-value result "configured"))
               (check (equal '("bluesky" "melissa")
                             (sort (quasar.control-plane::array-elements
                                    (quasar.protocol:json-value result "actors"))
                                   #'string<))))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-python-actor-live-run ()
  "Opt-in live lane: drive a real checkout with the real Melissa key."
  (unless (uiop:getenv "QUASAR_PYTHON_ACTORS_LIVE")
    (return-from test-python-actor-live-run t))
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-python-actor-commands plane)
           (check (quasar.control-plane::python-actors-checkout))
           (let ((response
                   (call-command
                    plane
                    (make-envelope "python-actors.status"
                                   (quasar.protocol:empty-object)
                                   :workspace "python-actors")))
                 (checkout (quasar.control-plane::python-actors-checkout)))
             (declare (ignore checkout))
             (check (string= (status response) "ok")))
           (let ((response
                   (python-actor-run-response
                    plane "melissa" "8.8.8.8"
                    :options (jsown:parse
                              "{\"fields\":{\"ip\":\"8.8.8.8\"},\"service\":\"global-ip\"}"))))
             (check (string= (status response) "ok"))
             (let* ((result (parsed-response-result response))
                    (ids (quasar.control-plane::array-elements
                          (quasar.protocol:json-value result "documents"))))
               (check (= 1 (quasar.protocol:json-value result "count")))
               (check (= 1 (length ids)))
               (check (search "starintel:observation" (first ids) :test #'string=))
               ;; The document must be retrievable from the workspace.
               (let ((fetched
                       (call-command
                        plane
                        (make-envelope
                         "document.get"
                         (quasar.protocol:json-object (cons "id" (first ids)))
                         :workspace "python-actors"))))
                 (check (string= (status fetched) "ok"))))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-python-actor-tests ()
  (test-python-actor-dotenv-parsing)
  (test-python-actor-target-document-shape)
  (test-python-actor-checkout-override)
  (test-python-actor-capabilities-advertised)
  (test-python-actor-status-lists-actors)
  (test-python-actor-run-ingests-documents)
  (test-python-actor-run-maps-subprocess-failure)
  (test-python-actor-run-rejects-invalid-payloads)
  (test-python-actor-live-run)
  t)
