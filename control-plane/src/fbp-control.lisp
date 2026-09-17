(in-package #:quasar.fbp.control)

(defvar *workflow-runtimes* (make-hash-table :test #'equal))
(defvar *workflow-lock* (bt:make-lock "quasar-fbp-manager"))
(defvar *runtime-services* nil)
(defvar *runtime-grants* nil)
(defvar *automation-executable* nil)

(defun configure-fbp-runtime (&key services grants automation-executable)
  "Install host-owned adapters and grants. Workflow source cannot change these."
  (when (member :all grants)
    (error "Wildcard FBP grants are forbidden."))
  (setf *runtime-services* (copy-list services)
        *runtime-grants* (copy-list grants)
        *automation-executable* automation-executable)
  t)

(defun endpoint-url (endpoint path)
  (format nil "~A~A"
          (string-right-trim "/" endpoint)
          (if (and (plusp (length path)) (char= (char path 0) #\/))
              path
              (concatenate 'string "/" path))))

(defun manifest-operations (endpoint)
  (let* ((body (dex:get (endpoint-url endpoint "/client-manifest.json")
                        :headers '(("accept" . "application/json"))))
         (document (jsown:parse body)))
    (quasar.protocol:json-value document "operations")))

(defun operation-field (operation name &optional default)
  (quasar.protocol:json-value operation name default))

(defun array-values (value)
  (if (and (consp value) (eq (first value) :array)) (rest value) value))

(defun request-object (value)
  (cond
    ((quasar.protocol:object-p value) value)
    ((listp value) (json-value value))
    (t (error 'quasar.protocol:quasar-error
              :code "fbp.invalid-starintel-request"
              :message "StarIntel operation input must be an object."
              :details (quasar.protocol:empty-object)))))

(defun replace-path-parameter (path name value)
  (let ((needle (format nil "{~A}" name)))
    (with-output-to-string (stream)
      (loop with start = 0
            for found = (search needle path :start2 start)
            do (write-string path stream :start start :end found)
            if found
              do (write-string (quri:url-encode (princ-to-string value)) stream)
                 (setf start (+ found (length needle)))
            else do (return)))))

(defun operation-path (operation request)
  (let ((path (operation-field operation "path")))
    (dolist (name (array-values (operation-field operation "path_parameters" nil)) path)
      (let ((value (quasar.protocol:json-value request name)))
        (unless value
          (error 'quasar.protocol:quasar-error
                 :code "fbp.missing-path-parameter"
                 :message (format nil "Missing StarIntel path parameter ~A." name)
                 :details (quasar.protocol:empty-object)))
        (setf path (replace-path-parameter path name value))))))

(defun query-pairs (operation request)
  (loop for parameter in (array-values (operation-field operation "query_parameters" nil))
        for name = (operation-field parameter "name")
        for value = (quasar.protocol:json-value request name)
        when value collect (cons name (princ-to-string value))))

(defun operation-body (operation request)
  (let ((schema (operation-field operation "request_schema" nil)))
    (unless (or (null schema) (eq schema :null))
      (let* ((properties (quasar.protocol:json-value schema "properties"
                                                     (quasar.protocol:empty-object)))
             (body (quasar.protocol:empty-object)))
        (dolist (name (quasar.protocol:object-keys properties) body)
          (let ((value (quasar.protocol:json-value request name :missing)))
            (unless (eq value :missing)
              (quasar.protocol:object-set body name value))))))))

(defun make-starintel-operation-service (&key endpoint credential-resolver
                                              (authorization-header "authorization")
                                              (authorization-prefix "Bearer "))
  "Create an authenticated adapter that invokes only manifest-listed operations."
  (let ((validated-endpoint (quasar.fbp::validate-endpoint endpoint))
        (operations nil))
    (lambda (operation-id input config)
      (unless operations
        (setf operations (array-values (manifest-operations validated-endpoint))))
      (let* ((operation
               (find operation-id operations
                     :key (lambda (value) (operation-field value "operation_id"))
                     :test #'string=))
             (request (request-object input))
             (reference (or (getf config :credential-reference)
                            "credential:starintel-api"))
             (credential (and credential-resolver
                              (funcall credential-resolver reference))))
        (unless operation
          (error 'quasar.protocol:quasar-error
                 :code "fbp.unknown-starintel-operation"
                 :message "The operation is absent from the canonical StarIntel manifest."
                 :details (quasar.protocol:empty-object)))
        (unless (and (stringp credential) (plusp (length credential)))
          (error 'quasar.protocol:quasar-error
                 :code "fbp.credential-unavailable"
                 :message "The referenced StarIntel credential is unavailable."
                 :details (quasar.protocol:empty-object)))
        (let* ((path (operation-path operation request))
               (query (query-pairs operation request))
               (url (endpoint-url validated-endpoint path))
               (body (operation-body operation request))
               (headers (list (cons "accept" "application/json")
                              (cons authorization-header
                                    (concatenate 'string authorization-prefix credential))))
               (response
                 (dex:request url
                              :method (intern (string-upcase
                                               (operation-field operation "method"))
                                              :keyword)
                              :headers headers
                              :content (and body (jsown:to-json body))
                              :parameters query)))
          (handler-case (jsown:parse response)
            (error () response)))))))

(defun json-key (value)
  (string-downcase (substitute #\_ #\- (symbol-name value))))

(defun json-value (value)
  (cond
    ((or (stringp value) (numberp value) (eq value t) (null value)) value)
    ((keywordp value) (string-downcase (symbol-name value)))
    ((and (listp value) (or (null value) (keywordp (first value))))
     (let ((object (quasar.protocol:empty-object)))
       (loop for (key item) on value by #'cddr
             do (quasar.protocol:object-set object (json-key key) (json-value item)))
       object))
    ((listp value) (apply #'quasar.protocol:json-array (mapcar #'json-value value)))
    (t (princ-to-string value))))

(defun payload-string (payload key)
  (quasar.protocol:ensure-string
   (quasar.protocol:json-value payload key) key "fbp.invalid-request"))

(defun translate-fbp-error (thunk)
  (handler-case (funcall thunk)
    (quasar.fbp:fbp-error (condition)
      (error 'quasar.protocol:quasar-error
             :code (quasar.fbp:fbp-error-code condition)
             :message (quasar.fbp:fbp-error-message condition)
             :details (json-value (quasar.fbp:fbp-error-details condition))))))

(defun catalog-result ()
  (apply #'quasar.protocol:json-array
         (mapcar #'json-value (node-catalog))))

(defun validate-result (source)
  (let ((network (read-network source)))
    (quasar.protocol:json-object
     (cons "valid" t)
     (cons "id" (quasar.fbp:network-id network))
     (cons "canonicalSource" (network-to-lisp network)))))

(defun services-for-network (network)
  (declare (ignore network))
  (copy-list *runtime-services*))

(defun command-owner (envelope)
  (list (or quasar.control-plane::*command-principal* "internal")
        (or (quasar.protocol:command-envelope-workspace envelope) "default")))

(defun runtime-key (envelope id)
  (append (command-owner envelope) (list id)))

(defun require-operator ()
  (unless (and (eq quasar.control-plane::*command-authority-kind* :operator)
               quasar.control-plane::*command-principal*)
    (error 'quasar.protocol:quasar-error
           :code "security.forbidden"
           :message "This operation requires an authenticated local operator."
           :details (quasar.protocol:empty-object))))

(defun start-result (source envelope)
  (let* ((network (compile-network (read-network source)))
         (id (quasar.fbp:network-id network))
         (key (runtime-key envelope id))
         (runtime (make-runtime network :services (services-for-network network)
                                :grants *runtime-grants*)))
    (bt:with-lock-held (*workflow-lock*)
      (let ((old (gethash key *workflow-runtimes*)))
        (when old (stop-runtime old))
        (setf (gethash key *workflow-runtimes*) runtime)))
    (start-runtime runtime)
    (quasar.protocol:json-object
     (cons "id" id)
     (cons "status" "starting"))))

(defun runtime-for (envelope id)
  (or (gethash (runtime-key envelope id) *workflow-runtimes*)
      (error 'quasar.protocol:quasar-error
             :code "fbp.run-not-found"
             :message (format nil "Workflow run ~A does not exist." id)
             :details (quasar.protocol:empty-object))))

(defun status-result (id envelope)
  (let ((runtime (runtime-for envelope id)))
    (quasar.protocol:json-object
     (cons "id" id)
     (cons "status" (string-downcase (symbol-name (runtime-status runtime))))
     (cons "trace" (json-value (reverse (runtime-trace runtime)))))))

(defun stop-result (id envelope)
  (let ((runtime (runtime-for envelope id)))
    (stop-runtime runtime)
    (status-result id envelope)))

(defun deployment-result (source apply-p)
  (let* ((network (read-network source))
         (plan (automation-plan network :executable *automation-executable*)))
    (when apply-p
      (require-operator)
      (apply-automation-plan plan :execute-commands t))
    (json-value plan)))

(defun profile-result (payload apply-p)
  (let* ((endpoint (quasar.protocol:json-value payload "endpoint"))
         (reference (or (quasar.protocol:json-value payload "credentialReference")
                        "credential:starintel-api"))
         (shell-name (or (quasar.protocol:json-value payload "shell") "sh"))
         (plan (profile-plan :endpoint endpoint
                             :credential-reference reference
                             :shell (if (string= shell-name "bash") :bash :sh))))
    (when apply-p
      (require-operator)
      (apply-profile-plan plan))
    (json-value plan)))

(defun install-fbp-commands (plane)
  (quasar.control-plane:register-command
   plane "fbp.catalog.list"
   (lambda (payload envelope)
     (declare (ignore payload envelope))
     (catalog-result)))
  (quasar.control-plane:register-command
   plane "fbp.dsl.validate"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (translate-fbp-error
      (lambda () (validate-result (payload-string payload "source"))))))
  (quasar.control-plane:register-command
   plane "fbp.run.start"
   (lambda (payload envelope)
     (translate-fbp-error
      (lambda () (start-result (payload-string payload "source") envelope)))))
  (quasar.control-plane:register-command
   plane "fbp.run.stop"
   (lambda (payload envelope)
     (stop-result (payload-string payload "id") envelope)))
  (quasar.control-plane:register-command
   plane "fbp.run.status"
   (lambda (payload envelope)
     (status-result (payload-string payload "id") envelope)))
  (quasar.control-plane:register-command
   plane "fbp.deployment.plan"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (translate-fbp-error
      (lambda () (deployment-result (payload-string payload "source") nil)))))
  (quasar.control-plane:register-command
   plane "fbp.deployment.apply"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (translate-fbp-error
      (lambda () (deployment-result (payload-string payload "source") t)))))
  (quasar.control-plane:register-command
   plane "fbp.profile.plan"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (profile-result payload nil)))
  (quasar.control-plane:register-command
   plane "fbp.profile.apply"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (profile-result payload t)))
  plane)

(defun stop-all-workflows ()
  (bt:with-lock-held (*workflow-lock*)
    (maphash (lambda (id runtime)
               (declare (ignore id))
               (stop-runtime runtime))
             *workflow-runtimes*)
    (clrhash *workflow-runtimes*))
  t)
