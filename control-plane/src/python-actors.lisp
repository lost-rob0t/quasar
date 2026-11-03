(in-package #:quasar.control-plane)

;;; Python actor support: self-run starintel-pro-actors from Quasar.
;;;
;;; The Python pro-actor fleet (starintel-pro-actors) is the production
;;; enrichment path. Besides the hosted star-server/RabbitMQ deployment,
;;; every registered family can self-run as a plain CLI
;;; (`starintel-actor-run`, `starintel-melissa`, `starintel-actor-service`).
;;; This subsystem lets the Quasar control plane drive those standalone
;;; entry points against a local checkout (typically a git worktree), so
;;; every Python actor — and every Melissa DataSource product — is usable
;;; from a Quasar workspace without a broker.
;;;
;;; Credentials never pass through Quasar: the runner merely overlays the
;;; checkout's gitignored `.env` (plus PYTHONPATH) onto the subprocess
;;; environment and discards it afterwards.

(defparameter +python-actors-schema-version+ "0.9.0")
(defparameter +python-actors-default-run-timeout+ 180)
(defparameter +python-actors-max-run-timeout+ 600)
(defparameter +python-actors-max-output-bytes+ (* 8 1024 1024))
(defparameter +python-actors-module+ "starintel_pro_actors.actor_run_cli")

(defun python-actors-trim (value)
  (let ((trimmed (string-trim '(#\Space #\Tab) (or value ""))))
    (and (plusp (length trimmed)) trimmed)))

(defun python-actors-checkout ()
  "Resolve the starintel-pro-actors checkout to run, or NIL.
QUASAR_PRO_ACTORS_PATH wins when set; otherwise the sibling
~/starintel/starintel-pro-actors default is tried."
  (flet ((usable (path)
           (and path
                (plusp (length (namestring path)))
                (uiop:directory-exists-p
                 (merge-pathnames "python/src/starintel_pro_actors/" path))
                path)))
    (let ((override (python-actors-trim (uiop:getenv "QUASAR_PRO_ACTORS_PATH"))))
      (cond
        ;; An explicit path wins even when it is broken: status must surface
        ;; the misconfiguration instead of silently running another checkout.
        (override (usable (parse-namestring override)))
        (t (let ((home (python-actors-trim (uiop:getenv "HOME"))))
             (and home
                  (usable (merge-pathnames
                           "starintel/starintel-pro-actors/"
                           (parse-namestring home))))))))))

(defun python-actors-python (checkout)
  "Pick the interpreter for the actor CLI: QUASAR_PYTHON, the checkout venv,
then python3."
  (or (python-actors-trim (uiop:getenv "QUASAR_PYTHON"))
      (let ((venv (merge-pathnames "python/.venv/bin/python" checkout)))
        (and (uiop:file-exists-p venv) (namestring venv)))
      "python3"))

(defun python-actors-parse-dotenv (text)
  "Parse simple KEY=VALUE lines; ignore blanks and # comments."
  (remove
   nil
   (loop for line in (uiop:split-string text :separator '(#\Newline))
         for trimmed = (string-trim '(#\Space #\Tab #\Return) line)
         unless (or (zerop (length trimmed))
                    (char= (char trimmed 0) #\#))
           collect (let ((position (position #\= trimmed)))
                     (when position
                       (let ((key (string-trim '(#\Space #\Tab)
                                               (subseq trimmed 0 position)))
                             (value (string-trim '(#\Space #\Tab)
                                                 (subseq trimmed (1+ position))))
                         (and (plusp (length key))
                              (cons key value))))))))

(defun python-actors-process-environment (checkout)
  "Full subprocess environment: current env, the checkout's gitignored .env
overlaid, and the actor package first on PYTHONPATH."
  (let* ((dotenv
           (or (ignore-errors
                 (uiop:read-file-string (merge-pathnames ".env" checkout)))
               ""))
         (source (namestring (merge-pathnames "python/src/" checkout)))
         (existing (or (uiop:getenv "PYTHONPATH") ""))
         (overlay (append
                   (python-actors-parse-dotenv dotenv)
                   (list
                    (cons "PYTHONPATH"
                          (if (plusp (length existing))
                              (format nil "~A:~A" source existing)
                              source))))))
    #+sbcl
    (let ((table (make-hash-table :test #'equal)))
      (dolist (entry
                (mapcar (lambda (string)
                          (let ((position (position #\= string)))
                            (cons (subseq string 0 position)
                                  (subseq string (1+ position)))))
                        (sb-ext:posix-environ)))
        (setf (gethash (car entry) table) (cdr entry)))
      (dolist (entry overlay)
        (setf (gethash (car entry) table) (cdr entry)))
      (loop for key being the hash-keys of table
              using (hash-value value)
            collect (cons key value)))
    #-sbcl
    (error "python-actors requires SBCL for environment passing.")))

(defun python-actors-execute-process (python arguments checkout environment timeout)
  "Run the actor CLI synchronously with a deadline.
Returns (values stdout stderr exit) with exit :timeout on deadline."
  (let ((process
          (uiop:launch-program (list* python "-m" +python-actors-module+ arguments)
                               :directory (merge-pathnames "python/" checkout)
                               :output :string
                               :error-output :string
                               :environment environment))
        (deadline (+ (get-universal-time) timeout)))
    (loop until (not (uiop:process-alive-p process))
          do (sleep 0.05)
          when (> (get-universal-time) deadline)
            do (ignore-errors (uiop:terminate-process process :urgent t))
               (return-from python-actors-execute-process
                 (values "" "python-actors run timed out" :timeout)))
    (multiple-value-bind (stdout stderr exit)
        (uiop:wait-process process)
      (values (or stdout "") (or stderr "") exit))))

(defun python-actors-error (code message)
  (error 'quasar.protocol:quasar-error
         :code code
         :message message
         :details (quasar.protocol:empty-object)))

(defun python-actors-slug (value)
  (with-output-to-string (stream)
    (loop for character across value
          do (write-char (if (find character "/\\:\r\n ")
                             #\_
                             character)
                         stream))))

(defun python-actors-options-array (options-object)
  "Convert a client options mapping to canonical target option entries."
  (let ((options (or options-object (quasar.protocol:empty-object))))
    (apply #'quasar.protocol:json-array
           (loop for key in (sort (quasar.protocol:object-keys options) #'string<)
                 collect (quasar.protocol:json-object
                          (cons "key" key)
                          (cons "value"
                                (quasar.protocol:clone-json
                                 (quasar.protocol:json-value options key))))))))

(defun python-actors-now ()
  (multiple-value-bind (second minute hour day month year)
      (decode-universal-time (get-universal-time) 0)
    (declare (ignore second))
    (format nil "~4,'0D-~2,'0D-~2,'0DT~2,'0D:~2,'0D:00Z"
            year month day hour minute)))

(defun python-actors-target-document (actor target-value options-object)
  (quasar.protocol:json-object
   (cons "_id"
         (format nil "target:python-actors:~A:~A"
                 actor (python-actors-slug target-value)))
   (cons "dataset" "quasar-python-actors")
   (cons "dtype" "target")
   (cons "schema_version" +python-actors-schema-version+)
   (cons "version" 1)
   (cons "date_added" (python-actors-now))
   (cons "date_updated" (python-actors-now))
   (cons "sources" (quasar.protocol:json-array))
   (cons "evidence" (quasar.protocol:json-array))
   (cons "data"
         (quasar.protocol:json-object
          (cons "actor" actor)
          (cons "target" target-value)
          (cons "options" (python-actors-options-array options-object))))))

(defun python-actors-parse-jsonl (stdout)
  "Decode actor output lines into a list of canonical documents."
  (loop for line in (uiop:split-string stdout :separator '(#\Newline))
        for trimmed = (string-trim '(#\Space #\Tab #\Return) line)
        unless (zerop (length trimmed))
          collect (let ((document (handler-case (jsown:parse trimmed)
                                    (error ()
                                      (python-actors-error
                                       "python-actors.invalid-output"
                                       "The actor emitted output that is not JSONL documents.")))))
                    (unless (quasar.protocol:object-p document)
                      (python-actors-error
                       "python-actors.invalid-output"
                       "The actor emitted a non-object JSON line."))
                    document)))

(defun python-actors-command-envelope (envelope command payload)
  (quasar.protocol:encode
   (quasar.protocol:json-object
    (cons "protocol" quasar.protocol:+protocol-version+)
    (cons "id" (format nil "pa-~36R" (random most-positive-fixnum)))
    (cons "command" command)
    (cons "payload" payload)
    (cons "metadata"
          (quasar.protocol:json-object
           (cons "client" "quasar-python-actors")
           (cons "workspace"
                 (or (quasar.protocol:command-envelope-workspace envelope)
                     "default")))))))

(defun python-actors-submit-and-wait (plane envelope command payload)
  "Submit one command through the control-plane mailbox and wait for the
reply envelope (parsed)."
  (let ((box (cons nil nil))
        (lock (bt:make-lock "python-actors-reply"))
        (condition-variable (bt:make-condition-variable)))
    (submit-command plane
                    (python-actors-command-envelope envelope command payload)
                    (lambda (response)
                      (bt:with-lock-held (lock)
                        (setf (car box) response)
                        (bt:condition-notify condition-variable))))
    (bt:with-lock-held (lock)
      (loop until (car box)
            do (bt:condition-wait condition-variable lock)))
    (jsown:parse (car box))))

(defun python-actors-document-exists-p (plane envelope id)
  (let ((response (python-actors-submit-and-wait
                   plane envelope "document.get"
                   (quasar.protocol:json-object (cons "id" id)))))
    (string= (jsown:val response "status") "ok")))

(defun python-actors-ingest (plane envelope documents)
  "Create or update every emitted document in one workspace transaction."
  (if (null documents)
      (quasar.protocol:json-object
       (cons "created" 0)
       (cons "updated" 0))
      (let* ((pairs
               (loop for document in documents
                     for id = (quasar.protocol:json-value document "_id")
                     for existing = (python-actors-document-exists-p
                                     plane envelope id)
                     collect (cons (if existing "document.update" "document.create")
                                   document)))
             (operations
               (loop for (type . document) in pairs
                     collect (quasar.protocol:json-object
                              (cons "type" type)
                              (cons "payload" document))))
             (response
               (python-actors-submit-and-wait
                plane envelope "workspace.transaction"
                (quasar.protocol:json-object
                 (cons "operations"
                       (apply #'quasar.protocol:json-array operations))))))
        (unless (string= (jsown:val response "status") "ok")
          (python-actors-error
           "python-actors.ingest-failed"
           (format
            nil
            "Ingesting actor documents failed: ~A"
            (handler-case
                (jsown:val (jsown:val response "error") "message")
              (error () "transaction rejected")))))
        (quasar.protocol:json-object
         (cons "created" (count "document.create" pairs :key #'car :test #'string=))
         (cons "updated" (count "document.update" pairs :key #'car :test #'string=))))))

(defun python-actors-valid-timeout (requested)
  (typecase requested
    (integer (min (max requested 1) +python-actors-max-run-timeout+))
    (otherwise +python-actors-default-run-timeout+)))

(defun python-actors-perform-run (plane payload envelope)
  (let* ((actor (quasar.protocol:json-value payload "actor"))
         (target-value (quasar.protocol:json-value payload "target"))
         (options-object (quasar.protocol:json-value payload "options"))
         (checkout (python-actors-checkout)))
    (unless (and (stringp actor) (plusp (length actor)))
      (python-actors-error "python-actors.invalid-target"
                           "payload.actor must be a non-empty string."))
    (unless (and (stringp target-value) (plusp (length target-value)))
      (python-actors-error "python-actors.invalid-target"
                           "payload.target must be a non-empty string."))
    (unless checkout
      (python-actors-error
       "python-actors.not-configured"
       "No starintel-pro-actors checkout found; set QUASAR_PRO_ACTORS_PATH."))
    (when options-object
      (unless (quasar.protocol:object-p options-object)
        (python-actors-error "python-actors.invalid-target"
                             "payload.options must be an object.")))
    (let* ((python (python-actors-python checkout))
           (environment (python-actors-process-environment checkout))
           (timeout (python-actors-valid-timeout
                     (quasar.protocol:json-value payload "timeoutSeconds")))
           (target-json (quasar.protocol:encode
                         (python-actors-target-document
                          actor target-value options-object))))
      (multiple-value-bind (stdout stderr exit)
          (funcall (control-plane-python-actors-executor plane)
                   python
                   (list "run" actor "--target" target-json)
                   checkout
                   environment
                   timeout)
        (cond
          ((eq exit :timeout)
           (python-actors-error "python-actors.timeout"
                                "The actor run exceeded its deadline."))
          ((not (zerop exit))
           (python-actors-error
            "python-actors.actor-failed"
            (format nil "Actor ~A failed (exit ~A): ~A"
                    actor exit
                    (subseq stderr 0 (min (length stderr) 2000)))))
          (t
           (when (> (length stdout) +python-actors-max-output-bytes+)
             (python-actors-error "python-actors.output-too-large"
                                  "The actor emitted more output than Quasar accepts."))
           (let* ((documents (python-actors-parse-jsonl stdout))
                  (ingest (python-actors-ingest plane envelope documents)))
             (quasar.protocol:json-object
              (cons "actor" actor)
              (cons "count" (length documents))
              (cons "documents"
                    (apply #'quasar.protocol:json-array
                           (mapcar (lambda (document)
                                     (quasar.protocol:json-value document "_id"))
                                   documents)))
              (cons "created" (quasar.protocol:json-value ingest "created"))
              (cons "updated" (quasar.protocol:json-value ingest "updated"))))))))))

(defun python-actors-status (plane)
  (let ((checkout (python-actors-checkout)))
    (if (not checkout)
        (quasar.protocol:json-object
         (cons "configured" :false)
         (cons "reason"
               "No starintel-pro-actors checkout found; set QUASAR_PRO_ACTORS_PATH.")
         (cons "actors" (quasar.protocol:json-array)))
        (let* ((python (python-actors-python checkout))
               (environment (python-actors-process-environment checkout)))
          (multiple-value-bind (stdout stderr exit)
              (funcall (control-plane-python-actors-executor plane)
                       python (list "list") checkout
                       environment +python-actors-default-run-timeout+)
            (declare (ignore stderr))
            (if (zerop exit)
                (quasar.protocol:json-object
                 (cons "configured" :true)
                 (cons "checkout" (namestring checkout))
                 (cons "python" python)
                 (cons "actors"
                       (apply #'quasar.protocol:json-array
                              (sort
                               (loop for line in (uiop:split-string
                                                  stdout :separator '(#\Newline))
                                     for trimmed = (string-trim
                                                    '(#\Space #\Tab #\Return) line)
                                     unless (zerop (length trimmed))
                                       collect (first (uiop:split-string
                                                       trimmed :separator '(#\Tab))))
                               #'string<))))
                (quasar.protocol:json-object
                 (cons "configured" :false)
                 (cons "checkout" (namestring checkout))
                 (cons "python" python)
                 (cons "reason" (format nil "actor CLI unavailable (exit ~A)" exit))
                 (cons "actors" (quasar.protocol:json-array))))))))))

(defun install-python-actor-commands (plane)
  "Register local self-run commands for the Python pro-actor fleet.

Registration does not grant access by itself: quasar.ws still requires the
session capability list to carry these command names, so hosted deployments
derive them from entitlements exactly like pro-actors.*."
  (register-command
   plane "python-actors.status"
   (lambda (payload envelope)
     (declare (ignore payload envelope))
     (python-actors-status plane)))
  (register-async-command
   plane "python-actors.run"
   (lambda (request-id payload envelope reply)
     (bt:make-thread
      (lambda ()
        (handler-case
            (funcall reply
                     (quasar.protocol:encode-result
                      request-id
                      (python-actors-perform-run plane payload envelope)))
          (quasar.protocol:quasar-error (condition)
            (funcall reply
                     (quasar.protocol:quasar-error-to-envelope request-id condition)))
          (error (condition)
            (quasar.log:log-event
             :error "python-actors" "run.crashed"
             :request-id request-id
             :condition (princ-to-string condition))
            (funcall reply
                     (quasar.protocol:encode-error
                      request-id "python-actors.failed"
                      "The python actor run could not be completed."
                      (quasar.protocol:empty-object))))))
      :name "quasar-python-actor-run")))
  plane)
