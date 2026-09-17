(in-package #:quasar.fbp.control)

(defvar *workflow-runtimes* (make-hash-table :test #'equal))
(defvar *workflow-lock* (bt:make-lock "quasar-fbp-manager"))
(defvar *runtime-services* nil)
(defvar *runtime-grants* nil)
(defvar *runtime-limits* '(:packets 100000 :bytes 67108864 :seconds 3600 :trace 1000
                           :concurrency 4))
(defvar *automation-executable* nil)
(defvar *starintel-node-ids* nil)
(defvar *starintel-registry-lock* (bt:make-lock "quasar-starintel-registry"))
(defvar *starintel-endpoint* nil)
(defvar *starintel-credential-reference* "credential:starintel-api")
(defvar *starintel-allowed-operations* nil)

(defun configure-fbp-runtime (&key services grants limits automation-executable
                                   starintel-endpoint
                                   starintel-allowed-operations
                                   (starintel-credential-reference
                                     "credential:starintel-api"))
  "Install host-owned adapters and grants. Workflow source cannot change these."
  (when (member :all grants)
    (error "Wildcard FBP grants are forbidden."))
  (setf *runtime-services* (copy-list services)
        *runtime-grants* (copy-list grants)
        *runtime-limits* (copy-list (or limits *runtime-limits*))
        *automation-executable* automation-executable
        *starintel-endpoint* starintel-endpoint
        *starintel-allowed-operations* (copy-list starintel-allowed-operations)
        *starintel-credential-reference* starintel-credential-reference)
  t)

(defun endpoint-url (endpoint path)
  (format nil "~A~A"
          (string-right-trim "/" endpoint)
          (if (and (plusp (length path)) (char= (char path 0) #\/))
              path
              (concatenate 'string "/" path))))

(defun manifest-document (endpoint)
  (let* ((validated-endpoint (quasar.fbp::validate-endpoint endpoint))
         (body (dex:get (endpoint-url validated-endpoint "/client-manifest.json")
                        :headers '(("accept" . "application/json"))
                        :max-redirects 0
                        :connect-timeout 10
                        :read-timeout 30))
         (document (jsown:parse body)))
    (unless (string= (quasar.protocol:json-value document "schema" "")
                     "starintel-client-manifest-v1")
      (error "Unsupported StarIntel client manifest schema."))
    document))

(defun manifest-operations (endpoint)
  (quasar.protocol:json-value (manifest-document endpoint) "operations"))

(defun operation-field (operation name &optional default)
  (quasar.protocol:json-value operation name default))

(defun array-values (value)
  (if (and (consp value) (eq (first value) :array)) (rest value) value))

(declaim (ftype (function (t) t) json-value))

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
  (let ((path (or (operation-field operation "openapi_path" nil)
                  (operation-field operation "path"))))
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
        for value = (quasar.protocol:json-value request name :missing)
        unless (eq value :missing)
          collect (cons name
                        (cond
                          ((eq value t) "true")
                          ((null value) "false")
                          (t (princ-to-string value))))))

(defun operation-body (operation request)
  (let ((schema (operation-field operation "request_schema" nil)))
    (unless (or (null schema) (eq schema :null))
      (let* ((properties (quasar.protocol:json-value schema "properties"
                                                     (quasar.protocol:empty-object)))
             (names (quasar.protocol:object-keys properties)))
        (if names
            (let ((body (quasar.protocol:empty-object)))
              (dolist (name names body)
                (let ((value (quasar.protocol:json-value request name :missing)))
                  (unless (eq value :missing)
                    (quasar.protocol:object-set body name value)))))
            (quasar.protocol:json-value request "request" request))))))

(defun credential-reference-value (reference allowed-credential-references
                                    credential-resolver)
  "Resolve one exact host-allowed credential reference, never a literal secret."
  (unless (and (stringp reference)
               (member reference allowed-credential-references :test #'string=))
    (error 'quasar.protocol:quasar-error
           :code "fbp.credential-reference-denied"
           :message "The host did not allow this credential reference."
           :details (quasar.protocol:empty-object)))
  (let ((credential (and credential-resolver
                         (funcall credential-resolver reference))))
    (unless (and (stringp credential) (plusp (length credential)))
      (error 'quasar.protocol:quasar-error
             :code "fbp.credential-unavailable"
             :message "The referenced StarIntel credential is unavailable."
             :details (quasar.protocol:empty-object)))
    credential))

(defun secret-schema-p (schema)
  (and (quasar.protocol:object-p schema)
       (or (operation-field schema "writeOnly" nil)
           (operation-field schema "x-starintel-secret" nil))))

(defun resolve-request-secret-value (schema value allowed-credential-references
                                     credential-resolver)
  "Return VALUE with secret-annotated leaves resolved through the host adapter."
  (cond
    ((secret-schema-p schema)
     (credential-reference-value value allowed-credential-references
                                 credential-resolver))
    ((and (quasar.protocol:object-p schema)
          (quasar.protocol:object-p value))
     (let ((properties (operation-field schema "properties"
                                        (quasar.protocol:empty-object)))
           (result (quasar.protocol:empty-object)))
       (dolist (name (quasar.protocol:object-keys value) result)
         (let ((item (quasar.protocol:json-value value name))
               (item-schema (and (quasar.protocol:object-p properties)
                                 (quasar.protocol:json-value properties name nil))))
           (quasar.protocol:object-set
            result name
            (if item-schema
                (resolve-request-secret-value
                 item-schema item allowed-credential-references credential-resolver)
                item))))))
    ((and (quasar.protocol:object-p schema)
          (string= (operation-field schema "type" "") "array")
          (listp value))
     (let ((items (operation-field schema "items" nil)))
       (if items
           (mapcar (lambda (item)
                     (resolve-request-secret-value
                      items item allowed-credential-references
                      credential-resolver))
                   (array-values value))
           value)))
    (t value)))

(defun operation-authorization-headers (operation config
                                        allowed-credential-references
                                        credential-resolver
                                        authorization-header
                                        authorization-prefix)
  (let ((authority (operation-field operation "authority" "")))
    (cond
      ((string= authority "public") nil)
      ((string= authority "bootstrap")
       (list
        (cons "X-Star-Bootstrap-Secret"
              (credential-reference-value
               (getf config :credential-reference)
               allowed-credential-references credential-resolver))))
      ((member authority '("authenticated" "administrator") :test #'string=)
       (list
        (cons authorization-header
              (concatenate
               'string authorization-prefix
               (credential-reference-value
                (getf config :credential-reference)
                allowed-credential-references credential-resolver)))))
      (t
       (error 'quasar.protocol:quasar-error
              :code "fbp.unknown-starintel-authority"
              :message "The StarIntel operation has an unsupported authority."
              :details (quasar.protocol:empty-object))))))

(defun ensure-supported-operation-authority (operation)
  (unless (member (operation-field operation "authority" "")
                  '("public" "bootstrap" "authenticated" "administrator")
                  :test #'string=)
    (error 'quasar.protocol:quasar-error
           :code "fbp.unknown-starintel-authority"
           :message "The StarIntel operation has an unsupported authority."
           :details (quasar.protocol:empty-object)))
  operation)

(defun make-starintel-operation-service (&key endpoint credential-resolver
                                              allowed-operations operations
                                              allowed-credential-references
                                              (requester #'dex:request)
                                              (authorization-header "authorization")
                                              (authorization-prefix "Bearer "))
  "Create an authenticated adapter that invokes only manifest-listed operations."
  (let ((validated-endpoint (quasar.fbp::validate-endpoint endpoint))
        (operation-table (array-values operations)))
    (lambda (operation-id input config)
      (unless (member operation-id allowed-operations :test #'string=)
        (error 'quasar.protocol:quasar-error
               :code "fbp.starintel-operation-denied"
               :message "The host did not allow this StarIntel operation."
               :details (quasar.protocol:empty-object)))
      (let* ((operation
               (find operation-id operation-table
                     :key (lambda (value) (operation-field value "operation_id"))
                     :test #'string=))
             (request (request-object input)))
        (unless operation
          (error 'quasar.protocol:quasar-error
                 :code "fbp.unknown-starintel-operation"
                 :message "The operation is absent from the canonical StarIntel manifest."
                 :details (quasar.protocol:empty-object)))
        (ensure-supported-operation-authority operation)
        (let* ((path (operation-path operation request))
               (query (query-pairs operation request))
               (url (endpoint-url validated-endpoint path))
               (raw-body (operation-body operation request))
               (body (and raw-body
                          (resolve-request-secret-value
                           (operation-field operation "request_schema") raw-body
                           allowed-credential-references credential-resolver)))
               (headers
                 (append
                  (list (cons "accept" "application/json")
                        (cons "content-type" "application/json"))
                  (operation-authorization-headers
                   operation config allowed-credential-references
                   credential-resolver authorization-header
                   authorization-prefix))))
          (multiple-value-bind (response status)
              (funcall requester url
                       :method (intern (string-upcase
                                        (operation-field operation "method"))
                                       :keyword)
                       :headers headers
                       :content (and body (jsown:to-json body))
                       :parameters query
                       :connect-timeout 10
                       :read-timeout 30
                       :max-redirects 0)
            (values (handler-case (jsown:parse response)
                      (error () response))
                    status)))))))

(defun descriptor-port (value)
  (let* ((schema (operation-field value "schema" nil))
         (type (and (quasar.protocol:object-p schema)
                    (operation-field schema "type" nil)))
         (write-only (and (quasar.protocol:object-p schema)
                          (operation-field schema "writeOnly" nil)))
         (secret (and (quasar.protocol:object-p schema)
                      (operation-field schema "x-starintel-secret" nil))))
    (quasar.fbp:make-port-spec
     :name (operation-field value "name")
     :schema (append (and (stringp type) (list :type type))
                     (and write-only (list :write-only t))
                     (and secret (list :secret t)))
     :required-p (and (operation-field value "required" nil) t)
     :array-p (and (operation-field value "array" nil) t))))

(defun operation-capabilities (operation)
  (list :starintel-operation
        (format nil "starintel.operation:~A"
                (operation-field operation "operation_id"))))

(defun unique-manifest-entry (id values field kind)
  (let ((matches (remove-if-not
                  (lambda (value) (string= id (operation-field value field)))
                  values)))
    (unless (= (length matches) 1)
      (error "StarIntel manifest must contain exactly one ~A for ~A." kind id))
    (first matches)))

(defun ensure-unique-descriptor-ports (descriptor field)
  (let* ((ports (array-values (operation-field descriptor field)))
         (names (mapcar (lambda (port) (operation-field port "name")) ports)))
    (unless (= (length names) (length (remove-duplicates names :test #'string=)))
      (error "StarIntel descriptor ~A has duplicate ~A names."
             (operation-field descriptor "id") field))))

(defun ensure-descriptor-routing-matches (descriptor operation)
  "Reject a UI descriptor whose routing metadata differs from its operation."
  (dolist (field '("method" "path" "openapi_path" "authority"
                   "path_parameters" "query_parameters"))
    (unless (equal (operation-field descriptor field :missing)
                   (operation-field operation field :missing))
      (error "StarIntel descriptor ~A has non-canonical ~A metadata."
             (operation-field descriptor "id") field))))

(defun register-starintel-operation-nodes (&key manifest allowed-operations)
  "Register exact host-allowed manifest types and return grants and operations."
  (let* ((nodes (array-values (quasar.protocol:json-value manifest "fbp_nodes")))
         (operations (array-values (quasar.protocol:json-value manifest "operations")))
         (specs nil)
         (grants nil))
    (dolist (operation-id allowed-operations)
      (let* ((operation (unique-manifest-entry
                         operation-id operations "operation_id" "operation"))
             (descriptor (unique-manifest-entry
                          operation-id nodes "operation_id" "descriptor"))
             (expected-id (format nil "starintel.operation/~A" operation-id))
             (config-schema (operation-field descriptor "config_schema"))
             (properties (operation-field config-schema "properties"))
             (operation-schema (operation-field properties "operation"))
             (capabilities (operation-capabilities operation))
             (captured-operation-id (copy-seq operation-id))
             (captured-node-id (copy-seq expected-id)))
        (unless (and (string= (operation-field descriptor "id") expected-id)
                     (string= (operation-field descriptor "component")
                              "starintel.operation")
                     (string= (operation-field operation-schema "const") operation-id))
          (error "Invalid StarIntel FBP descriptor identity for ~A." operation-id))
        (ensure-descriptor-routing-matches descriptor operation)
        (ensure-unique-descriptor-ports descriptor "inputs")
        (ensure-unique-descriptor-ports descriptor "outputs")
        (let ((existing (quasar.fbp:find-node-type expected-id :errorp nil)))
          (when (and existing
                     (not (member expected-id *starintel-node-ids* :test #'string=)))
            (error "StarIntel descriptor attempted to replace node type ~A." expected-id)))
        (setf grants (append capabilities grants))
        (push
         (quasar.fbp:make-node-type
          :id expected-id
          :label (operation-field descriptor "label")
          :category (operation-field descriptor "category")
          :inputs (mapcar #'descriptor-port
                          (array-values (operation-field descriptor "inputs")))
          :outputs (mapcar #'descriptor-port
                           (array-values (operation-field descriptor "outputs")))
          :capabilities capabilities
          :config-schema nil
          :descriptor descriptor
          :processor
          (lambda (inputs context)
            (let ((request (quasar.protocol:empty-object))
                  (invoke (quasar.fbp::required-service
                           context :starintel-operation)))
              (dolist (input inputs)
                (quasar.protocol:object-set request (car input) (cdr input)))
              (multiple-value-bind (body status)
                  (funcall invoke captured-operation-id request (getf context :config))
                (let ((port (format nil "status-~D" status)))
                  (unless (quasar.fbp::port-named
                           (quasar.fbp:node-type-outputs
                            (quasar.fbp:find-node-type captured-node-id)) port)
                    (error "StarIntel returned undeclared status ~D for ~A."
                           status captured-operation-id))
                  (list (cons port (list body))))))))
         specs)))
    (setf specs (nreverse specs))
    (bt:with-lock-held (*starintel-registry-lock*)
      (quasar.fbp:replace-node-types *starintel-node-ids* specs)
      (setf *starintel-node-ids* (mapcar #'quasar.fbp:node-type-id specs)))
    (values (remove-duplicates grants :test #'equal) operations)))

(defun clear-starintel-operation-nodes ()
  (bt:with-lock-held (*starintel-registry-lock*)
    (quasar.fbp:replace-node-types *starintel-node-ids* nil)
    (setf *starintel-node-ids* nil))
  t)

(defun json-key (value)
  (string-downcase (substitute #\_ #\- (symbol-name value))))

(defun json-value (value)
  (cond
    ((quasar.protocol:object-p value) value)
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
                                :grants *runtime-grants*
                                :host-limits *runtime-limits*)))
    (let ((old nil))
      (bt:with-lock-held (*workflow-lock*)
        (setf old (gethash key *workflow-runtimes*))
        (remhash key *workflow-runtimes*))
      (when old (stop-runtime old)))
    (start-runtime runtime)
    (bt:with-lock-held (*workflow-lock*)
      (setf (gethash key *workflow-runtimes*) runtime))
    (quasar.protocol:json-object
     (cons "id" id)
     (cons "status" "starting"))))

(defun runtime-for (envelope id)
  (or (bt:with-lock-held (*workflow-lock*)
        (gethash (runtime-key envelope id) *workflow-runtimes*))
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
  (let ((runtime nil))
    (bt:with-lock-held (*workflow-lock*)
      (setf runtime (gethash (runtime-key envelope id) *workflow-runtimes*))
      (when runtime (remhash (runtime-key envelope id) *workflow-runtimes*)))
    (unless runtime
      (error 'quasar.protocol:quasar-error
             :code "fbp.run-not-found" :message "Workflow run does not exist."
             :details (quasar.protocol:empty-object)))
    (stop-runtime runtime)
    (quasar.protocol:json-object
     (cons "id" id)
     (cons "status" (string-downcase (symbol-name (runtime-status runtime)))))))

(defun deployment-result (source apply-p)
  (let* ((network (read-network source))
         (plan (automation-plan network :executable *automation-executable*
                                :endpoint *starintel-endpoint*
                                :allowed-operations *starintel-allowed-operations*
                                :credential-reference
                                *starintel-credential-reference*)))
    (when apply-p
      (require-operator)
      (apply-automation-plan plan :execute-commands t))
    (json-value plan)))

(defun profile-result (payload apply-p)
  (let* ((endpoint (quasar.protocol:json-value payload "endpoint"))
         (reference (or (quasar.protocol:json-value payload "credentialReference")
                        "credential:starintel-api"))
         (allowed-operations
           (array-values
            (or (quasar.protocol:json-value payload "allowedOperations")
                nil)))
         (shell-name (or (quasar.protocol:json-value payload "shell") "sh"))
         (plan (profile-plan :endpoint endpoint
                             :credential-reference reference
                             :allowed-operations allowed-operations
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
  (let ((runtimes nil))
    (bt:with-lock-held (*workflow-lock*)
      (maphash (lambda (id runtime)
                 (declare (ignore id))
                 (push runtime runtimes))
               *workflow-runtimes*)
      (clrhash *workflow-runtimes*))
    (dolist (runtime runtimes) (stop-runtime runtime)))
  t)
