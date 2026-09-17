(defpackage #:quasar.fbp.tests
  (:use #:cl #:quasar.fbp)
  (:export #:run-fbp-tests))

(in-package #:quasar.fbp.tests)

(defvar *captured* nil)

(define-node test/capture
    (:label "Capture" :category "Tests"
     :inputs ((in :schema (:type "any")))
     :outputs ())
    (inputs context)
  (declare (ignore context))
  (push (cdr (assoc "in" inputs :test #'string=)) *captured*)
  nil)

(define-node test/two-outputs
    (:label "Two outputs" :category "Tests"
     :inputs ((in :schema (:type "any")))
     :outputs ((left :schema (:type "any"))
               (right :schema (:type "any"))))
    (inputs context)
  (declare (ignore context))
  (let ((value (cdr (assoc "in" inputs :test #'string=))))
    (list (cons "left" (list value))
          (cons "right" (list value value)))))

(define-node test/secret-input
    (:label "Secret input" :category "Tests"
     :inputs ((secret :schema (:type "string" :secret t)))
     :outputs ())
    (inputs context)
  (declare (ignore inputs context))
  nil)

(defvar *gate-semaphore* nil)
(defvar *gate-started-semaphore* nil)
(defvar *gate-lock* (bt:make-lock "quasar-fbp-test-gate"))
(defvar *gate-active* 0)
(defvar *gate-peak* 0)

(define-node test/gated
    (:label "Gated worker" :category "Tests"
     :inputs ((in :schema (:type "any")))
     :outputs ())
    (inputs context)
  (declare (ignore inputs context))
  (bt:with-lock-held (*gate-lock*)
    (incf *gate-active*)
    (setf *gate-peak* (max *gate-peak* *gate-active*)))
  (bt:signal-semaphore *gate-started-semaphore*)
  (unwind-protect
       (bt:wait-on-semaphore *gate-semaphore*)
    (bt:with-lock-held (*gate-lock*)
      (decf *gate-active*)))
  nil)

(define-node test/fail-after-gate
    (:label "Fail after gate starts" :category "Tests"
     :inputs ((in :schema (:type "any")))
     :outputs ())
    (inputs context)
  (declare (ignore inputs context))
  (loop until (bt:with-lock-held (*gate-lock*) (plusp *gate-active*))
        do (sleep 0.001))
  (error "intentional worker failure"))

(defun check (value format-control &rest arguments)
  (unless value
    (error (apply #'format nil format-control arguments))))

(defun signals-p (type thunk)
  (handler-case (progn (funcall thunk) nil)
    (error (condition) (typep condition type))))

(defun test-array-values (value)
  (if (and (consp value) (eq (first value) :array)) (rest value) value))

(defun set-json-test-value (object key value)
  (let ((pair (assoc key (rest object) :test #'string=)))
    (unless pair (error "Missing JSON test key ~A." key))
    (setf (cdr pair) value)))

(defun wait-until (predicate &key (seconds 2.0))
  (let ((deadline (+ (get-internal-real-time)
                     (round (* seconds internal-time-units-per-second)))))
    (loop
      (when (funcall predicate) (return t))
      (when (> (get-internal-real-time) deadline) (return nil))
      (sleep 0.005))))

(defun reset-gate-state ()
  (setf *gate-semaphore* (bt:make-semaphore :count 0)
        *gate-started-semaphore* (bt:make-semaphore :count 0))
  (bt:with-lock-held (*gate-lock*)
    (setf *gate-active* 0
          *gate-peak* 0)))

(defun gated-network (&key (include-failure nil))
  (let ((components nil)
        (iips nil))
    (dotimes (index 3)
      (let ((id (format nil "gate-~D" index)))
        (push (make-component-spec :id id :type "test/gated") components)
        (push (make-iip-spec :value index :to id :in "in") iips)))
    (when include-failure
      (push (make-component-spec :id "fail" :type "test/fail-after-gate") components)
      (push (make-iip-spec :value t :to "fail" :in "in") iips))
    (make-network :id "worker-pool"
                  :policy (make-sandbox-policy :limits '(:concurrency 2))
                  :components (nreverse components)
                  :iips (nreverse iips))))

(defun basic-network (&key (capacity 2) (enabled nil))
  (make-network
   :id "basic"
   :enabled-at-login-p enabled
   :components (list (make-component-spec :id "copy" :type "core/identity")
                     (make-component-spec :id "sink" :type "test/capture"))
   :connections (list (make-connection-spec :from "copy" :out "out"
                                            :to "sink" :in "in"
                                            :capacity capacity))
   :iips (list (make-iip-spec :value "hello" :to "copy" :in "in"))))

(defun test-validation-and-iip ()
  (setf *captured* nil)
  (let ((runtime (make-runtime (basic-network))))
    (check (= 1 (step-runtime runtime)) "Expected the IIP source to fire.")
    (check (= 1 (step-runtime runtime)) "Expected the sink to fire.")
    (check (equal *captured* '("hello")) "IIP routing failed: ~S" *captured*)))

(defun test-round-trip ()
  (let* ((network (basic-network :enabled t))
         (source (network-to-lisp network))
         (parsed (read-network source)))
    (check (string= source (network-to-lisp parsed))
           "FBP Lisp round-trip is not canonical.")))

(defun test-invalid-port ()
  (let ((network (basic-network)))
    (setf (connection-spec-out (first (network-connections network))) "missing")
    (check (signals-p 'validation-error (lambda () (validate-network network)))
           "An undeclared output port was accepted.")))

(defun test-sandbox-denial ()
  (let ((network
          (make-network
           :id "denied"
           :components (list (make-component-spec :id "exec" :type "process/exec"))
           :iips (list (make-iip-spec :value "x" :to "exec" :in "stdin")))))
    (check (signals-p 'sandbox-denied (lambda () (make-runtime network)))
           "A denied process capability passed validation.")))

(defun test-lossless-atomic-backpressure ()
  (let* ((network
           (make-network
            :id "atomic"
            :components
            (list (make-component-spec :id "source" :type "test/two-outputs")
                  (make-component-spec :id "left" :type "test/capture")
                  (make-component-spec :id "right" :type "test/capture"))
            :connections
            (list (make-connection-spec :from "source" :out "left"
                                        :to "left" :in "in" :capacity 1)
                  (make-connection-spec :from "source" :out "right"
                                        :to "right" :in "in" :capacity 1))
            :iips (list (make-iip-spec :value "held" :to "source" :in "in"))))
         (runtime (make-runtime network))
         (input (quasar.fbp::input-channel runtime "source" "in"))
         (left (first (gethash '("source" "left")
                               (quasar.fbp::runtime-outputs runtime))))
         (right (first (gethash '("source" "right")
                                (quasar.fbp::runtime-outputs runtime)))))
    (check (zerop (step-runtime runtime))
           "A multi-output activation committed without full capacity.")
    (check (= 1 (quasar.fbp::channel-size input))
           "Backpressure consumed the claimed input packet.")
    (check (and (zerop (quasar.fbp::channel-size left))
                (zerop (quasar.fbp::channel-size right)))
           "Backpressure partially committed a multi-port emission.")))

(defun fanout-network (packet-limit)
  (make-network
   :id "fanout-budget"
   :policy (make-sandbox-policy :limits (list :packets packet-limit))
   :components (list (make-component-spec :id "copy" :type "core/identity")
                     (make-component-spec :id "left" :type "test/capture")
                     (make-component-spec :id "right" :type "test/capture"))
   :connections (list (make-connection-spec :from "copy" :out "out"
                                            :to "left" :in "in")
                      (make-connection-spec :from "copy" :out "out"
                                            :to "right" :in "in"))
   :iips (list (make-iip-spec :value "one" :to "copy" :in "in"))))

(defun test-fanout-budget-counts-deliveries ()
  (let* ((rejected (make-runtime (fanout-network 1)))
         (input (quasar.fbp::input-channel rejected "copy" "in")))
    (check (signals-p 'sandbox-denied
                      (lambda () (step-runtime rejected)))
           "Two fan-out deliveries passed a one-packet budget.")
    (check (= 1 (quasar.fbp::channel-size input))
           "A rejected budget consumed its input."))
  (let* ((runtime (make-runtime (fanout-network 2)))
         (channels (gethash '("copy" "out")
                            (quasar.fbp::runtime-outputs runtime))))
    (check (= 1 (step-runtime runtime)) "A valid two-packet fan-out did not fire.")
    (let ((left (first (quasar.fbp::channel-queue (first channels))))
          (right (first (quasar.fbp::channel-queue (second channels)))))
      (check (and left right (not (eq left right)))
             "Fan-out reused one packet object across independent channels.")
      (check (/= (packet-sequence left) (packet-sequence right))
             "Fan-out deliveries did not receive distinct sequences."))))

(defun test-fixed-worker-pool-is-bounded-and-reused ()
  (reset-gate-state)
  (let ((runtime (make-runtime (gated-network))))
    (unwind-protect
         (progn
           (start-runtime runtime)
           (check (bt:wait-on-semaphore *gate-started-semaphore* :timeout 2)
                  "The first fixed-pool worker did not start.")
           (check (bt:wait-on-semaphore *gate-started-semaphore* :timeout 2)
                  "The second fixed-pool worker did not start.")
           (sleep 0.05)
           (check (= 2 (bt:with-lock-held (*gate-lock*) *gate-peak*))
                  "The runtime exceeded or failed to reach its concurrency bound.")
           (let ((workers
                   (bt:with-lock-held ((quasar.fbp::runtime-lock runtime))
                     (copy-list (quasar.fbp::runtime-worker-threads runtime)))))
             (check (= 2 (length workers))
                    "The runtime did not create exactly two persistent workers.")
             (bt:signal-semaphore *gate-semaphore*)
             (bt:signal-semaphore *gate-semaphore*)
             (check (bt:wait-on-semaphore *gate-started-semaphore* :timeout 2)
                    "A persistent worker did not accept the third activation.")
             (check (equal workers
                           (bt:with-lock-held ((quasar.fbp::runtime-lock runtime))
                             (copy-list
                              (quasar.fbp::runtime-worker-threads runtime))))
                    "The runtime replaced workers instead of reusing its fixed pool."))
           (bt:signal-semaphore *gate-semaphore*)
           (check (wait-until
                   (lambda ()
                     (bt:with-lock-held ((quasar.fbp::runtime-lock runtime))
                       (zerop (quasar.fbp::runtime-in-flight runtime)))))
                  "The fixed worker pool did not drain."))
      (loop repeat 4 do (bt:signal-semaphore *gate-semaphore*))
      (ignore-errors (stop-runtime runtime)))
    (check (null (quasar.fbp::runtime-worker-threads runtime))
           "Stopped runtime retained worker handles.")))

(defun test-worker-failure-stops-and-drains-pool ()
  (reset-gate-state)
  (let ((runtime (make-runtime (gated-network :include-failure t))))
    (unwind-protect
         (progn
           (start-runtime runtime)
           (check (wait-until
                   (lambda ()
                     (bt:with-lock-held (*gate-lock*) (plusp *gate-active*))))
                  "The gated activation never entered a worker.")
           (check (wait-until
                   (lambda ()
                     (bt:with-lock-held ((quasar.fbp::runtime-lock runtime))
                       (quasar.fbp::runtime-stop-p runtime))))
                  "A worker failure did not request runtime stop.")
           (bt:signal-semaphore *gate-semaphore*)
           (bt:signal-semaphore *gate-semaphore*)
           (check (wait-until
                   (lambda () (eq (runtime-status runtime) :failed)))
                  "The runtime did not report its worker failure.")
           (stop-runtime runtime)
           (check (and (null (quasar.fbp::runtime-thread runtime))
                       (null (quasar.fbp::runtime-worker-threads runtime))
                       (zerop (quasar.fbp::runtime-in-flight runtime)))
                  "Failed runtime did not join and clear its threads."))
      (loop repeat 4 do (bt:signal-semaphore *gate-semaphore*))
      (ignore-errors (stop-runtime runtime)))))

(defun test-worker-pool-start-failure-rolls-back ()
  (let ((runtime (make-runtime (gated-network)))
        (calls 0)
        (real-factory quasar.fbp::*runtime-thread-factory*))
    (let ((quasar.fbp::*runtime-thread-factory*
            (lambda (function &key name)
              (incf calls)
              (when (= calls 2)
                (error "intentional thread start failure"))
              (funcall real-factory function :name name))))
      (check (signals-p 'error (lambda () (start-runtime runtime)))
             "A partial worker-pool startup did not fail."))
    (check (and (null (quasar.fbp::runtime-thread runtime))
                (null (quasar.fbp::runtime-worker-threads runtime))
                (zerop (quasar.fbp::runtime-in-flight runtime))
                (loop for instance being the hash-values
                        of (quasar.fbp::runtime-instances runtime)
                      never (quasar.fbp::component-instance-busy-p instance)))
           "Thread-start failure did not roll back scheduler claims and handles.")))

(defun test-scheduler-failure-stops-and-joins-pool ()
  (let ((runtime (make-runtime (fanout-network 1))))
    (unwind-protect
         (progn
           (start-runtime runtime)
           (check (wait-until
                   (lambda () (eq (runtime-status runtime) :failed)))
                  "A scheduler-side budget failure did not fail the runtime.")
           (stop-runtime runtime)
           (check (and (null (quasar.fbp::runtime-thread runtime))
                       (null (quasar.fbp::runtime-worker-threads runtime))
                       (zerop (quasar.fbp::runtime-in-flight runtime)))
                  "Scheduler failure abandoned worker threads or in-flight work."))
      (ignore-errors (stop-runtime runtime)))))

(defun test-self-trust-is-rejected ()
  (check (signals-p 'sandbox-denied
                    (lambda ()
                      (read-network
                       "(define-network bad (:trusted-code t) (:component x core/identity) (:iip 1 x in))")))
         "A graph granted trust to itself."))

(defun test-literal-secret-is-rejected ()
  (let ((network (basic-network)))
    (setf (component-spec-config (first (network-components network)))
          '(:token "star_sk_v1_forbidden"))
    (check (signals-p 'validation-error (lambda () (validate-network network)))
           "A literal StarIntel key was accepted in component config."))
  (let ((network
          (make-network
           :id "secret-iip"
           :components (list (make-component-spec :id "secret" :type "test/secret-input"))
           :iips (list (make-iip-spec :value "raw-password"
                                     :to "secret" :in "secret")))))
    (check (signals-p 'validation-error (lambda () (validate-network network)))
           "A literal value was accepted for a secret-annotated input.")))

(defun test-profile-values-are-inert ()
  (check (signals-p 'validation-error
                    (lambda ()
                      (profile-plan :endpoint "http://127.0.0.1/$(touch-pwned)")))
         "A shell substitution was accepted in the endpoint.")
  (check (signals-p 'validation-error
                    (lambda ()
                      (profile-plan :credential-reference "star_sk_v1_raw")))
         "A raw key was accepted as a credential reference.")
  (check (signals-p 'validation-error
                    (lambda ()
                      (profile-plan :endpoint "http://starintel.example.test")))
         "Plain HTTP was accepted for a non-loopback StarIntel endpoint.")
  (check (signals-p 'validation-error
                    (lambda ()
                      (profile-plan :allowed-operations '("documents.get\nBAD=1"))))
         "An unsafe operation id was accepted by the profile installer.")
  (let ((content (getf (profile-plan
                        :allowed-operations '("targets.create" "documents.get"))
                       :content)))
    (check (search "QUASAR_STARINTEL_ALLOWED_OPERATIONS='targets.create,documents.get'"
                   content)
           "The shell profile omitted its exact StarIntel operation allowlist.")))

(defun test-installer-no-secret ()
  (let* ((secret "star_sk_v1_must_not_appear")
         (network (basic-network :enabled t))
         (plan (automation-plan network :graph-path #P"/tmp/basic.lisp"
                                        :executable "/bin/true"))
         (rendered (with-output-to-string (stream) (prin1 plan stream))))
    (check (not (search secret rendered)) "Installer plan leaked a secret.")
    (check (getf plan :enable) "Enabled automation did not request systemd enable."))
  (let* ((plan (automation-plan (basic-network :enabled t)
                                :graph-path #P"/tmp/basic.lisp"
                                :executable "/bin/true"
                                :endpoint "http://127.0.0.1:5000"
                                :credential-reference "credential:starintel-api"))
         (unit (getf plan :unit-source)))
    (check (search "/.config/systemd/user/quasar-fbp@basic.service"
                   (namestring (getf plan :unit-path)))
           "The user unit path is outside XDG_CONFIG_HOME/systemd/user.")
    (check (and (search "ExecStart=" unit)
                (search " fbp-run --graph" unit))
           "The user unit does not invoke the packaged fbp-run entry point.")
    (check (search "STARINTEL_ENDPOINT=http://127.0.0.1:5000" unit)
           "The user unit omitted its StarIntel endpoint.")
    (check (search "QUASAR_STARINTEL_ALLOWED_OPERATIONS=" unit)
           "The user unit omitted its host-owned operation allowlist.")
    (check (search "LoadCredential=\"starintel-api:" unit)
           "The user unit omitted its systemd credential reference."))
  (let ((network
          (make-network
           :id "secret-reference-authority"
           :components (list (make-component-spec :id "secret" :type "test/secret-input"))
           :iips (list (make-iip-spec :value "credential:unapproved"
                                     :to "secret" :in "secret")))))
    (check (signals-p
            'validation-error
            (lambda ()
              (automation-plan network
                               :executable "/bin/true"
                               :endpoint "http://127.0.0.1:5000"
                               :credential-reference "credential:starintel-api")))
           "An unapproved secret-input credential reference passed deployment planning.")))

(defun test-manifest-node-dispatch-when-control-loaded ()
  (let ((register
          (and (find-package "QUASAR.FBP.CONTROL")
               (find-symbol "REGISTER-STARINTEL-OPERATION-NODES"
                            "QUASAR.FBP.CONTROL"))))
  (when (and register (fboundp register))
    (let* ((manifest
             (jsown:parse
              "{\"schema\":\"starintel-client-manifest-v1\",\"operations\":[{\"operation_id\":\"documents.get\",\"method\":\"get\",\"path\":\"/documents/:id\",\"openapi_path\":\"/documents/{id}\",\"authority\":\"authenticated\",\"scopes\":[\"documents:read\"],\"path_parameters\":[\"id\"],\"query_parameters\":[],\"request_schema\":null,\"responses\":[{\"status\":200,\"schema\":{\"type\":\"object\"}}]}],\"fbp_nodes\":[{\"id\":\"starintel.operation/documents.get\",\"component\":\"starintel.operation\",\"operation_id\":\"documents.get\",\"method\":\"get\",\"path\":\"/documents/:id\",\"openapi_path\":\"/documents/{id}\",\"authority\":\"authenticated\",\"path_parameters\":[\"id\"],\"query_parameters\":[],\"label\":\"Get document\",\"category\":\"StarIntel API\",\"inputs\":[{\"name\":\"id\",\"source\":\"path\",\"required\":true,\"schema\":{\"type\":\"string\"}}],\"outputs\":[{\"name\":\"status-200\",\"status\":200,\"schema\":{\"type\":\"object\"}}],\"config_schema\":{\"type\":\"object\",\"properties\":{\"operation\":{\"const\":\"documents.get\"},\"credential_reference\":{\"type\":\"string\"}}}}]}"))
           (called nil))
      (unwind-protect
           (progn
             (let ((descriptor
                     (first (test-array-values (jsown:val manifest "fbp_nodes")))))
               (dolist (field '("method" "path" "openapi_path" "authority"
                                "path_parameters" "query_parameters"))
                 (let ((original (jsown:val descriptor field)))
                   (set-json-test-value
                    descriptor field (if (stringp original) "mismatch" :null))
                   (check (signals-p
                           'error
                           (lambda ()
                             (uiop:symbol-call
                              :quasar.fbp.control
                              :register-starintel-operation-nodes
                              :manifest manifest
                              :allowed-operations '("documents.get"))))
                          "Divergent descriptor ~A metadata was registered."
                          field)
                   (set-json-test-value descriptor field original))))
             (multiple-value-bind (grants operations)
               (uiop:symbol-call :quasar.fbp.control
                                 :register-starintel-operation-nodes
                                 :manifest manifest
                                 :allowed-operations '("documents.get"))
             (let* ((resolver-called nil)
                   (service
                     (uiop:symbol-call
                      :quasar.fbp.control :make-starintel-operation-service
                      :endpoint "http://127.0.0.1:5000"
                      :operations operations
                      :allowed-operations '("documents.get")
                      :allowed-credential-references
                      '("credential:starintel-api")
                      :credential-resolver
                      (lambda (reference)
                        (declare (ignore reference))
                        (setf resolver-called t)
                        "forbidden"))))
               (check (signals-p
                       'error
                       (lambda ()
                         (funcall service "documents.get"
                                  (jsown:parse "{\"id\":\"doc-1\"}")
                                  '(:credential-reference "credential:other"))))
                      "An unapproved credential reference reached dispatch.")
               (check (not resolver-called)
                      "An unapproved credential reference reached the resolver."))
             (let* ((network
                      (make-network
                       :id "typed-manifest"
                       :components
                       (list (make-component-spec
                              :id "get" :type "starintel.operation/documents.get"
                              :config '(:operation "documents.get"
                                        :credential-reference
                                        "credential:starintel-api")))
                       :iips (list (make-iip-spec :value "doc-1"
                                                 :to "get" :in "id"))))
                    (runtime
                      (make-runtime
                       network :grants grants
                       :services
                       (list :starintel-operation
                             (lambda (operation request config)
                               (declare (ignore request config))
                               (setf called operation)
                               (values (jsown:parse "{\"ok\":true}") 200))))))
               (check (= 1 (step-runtime runtime))
                      "Typed manifest operation did not execute.")
               (check (string= called "documents.get")
                      "Dynamic operation processor lost its immutable operation id."))))
        (uiop:symbol-call :quasar.fbp.control :clear-starintel-operation-nodes))))))

(defun test-starintel-adapter-authority-secrets-and-query-booleans ()
  (let ((maker
          (and (find-package "QUASAR.FBP.CONTROL")
               (find-symbol "MAKE-STARINTEL-OPERATION-SERVICE"
                            "QUASAR.FBP.CONTROL"))))
    (when (and maker (fboundp maker))
      (let* ((document
               (jsown:parse
                "{\"operations\":[{\"operation_id\":\"public.get\",\"method\":\"get\",\"path\":\"/public\",\"openapi_path\":\"/public\",\"authority\":\"public\",\"path_parameters\":[],\"query_parameters\":[{\"name\":\"enabled\"},{\"name\":\"force\"}],\"request_schema\":null},{\"operation_id\":\"bootstrap.post\",\"method\":\"post\",\"path\":\"/bootstrap\",\"openapi_path\":\"/bootstrap\",\"authority\":\"bootstrap\",\"path_parameters\":[],\"query_parameters\":[],\"request_schema\":null},{\"operation_id\":\"secure.post\",\"method\":\"post\",\"path\":\"/secure\",\"openapi_path\":\"/secure\",\"authority\":\"authenticated\",\"path_parameters\":[],\"query_parameters\":[],\"request_schema\":{\"type\":\"object\",\"properties\":{\"payload\":{\"type\":\"object\",\"properties\":{\"password\":{\"type\":\"string\",\"writeOnly\":true},\"visible\":{\"type\":\"string\"}}},\"items\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"token\":{\"type\":\"string\",\"x-starintel-secret\":true}}}}}}},{\"operation_id\":\"admin.get\",\"method\":\"get\",\"path\":\"/admin\",\"openapi_path\":\"/admin\",\"authority\":\"administrator\",\"path_parameters\":[],\"query_parameters\":[],\"request_schema\":null},{\"operation_id\":\"unknown.get\",\"method\":\"get\",\"path\":\"/unknown\",\"openapi_path\":\"/unknown\",\"authority\":\"api-key\",\"path_parameters\":[],\"query_parameters\":[],\"request_schema\":{\"type\":\"object\",\"properties\":{\"token\":{\"type\":\"string\",\"writeOnly\":true}}}}]}"))
             (operations (jsown:val document "operations"))
             (allowed-operations
               '("public.get" "bootstrap.post" "secure.post" "admin.get"
                 "unknown.get"))
             (allowed-references
               '("credential:api" "credential:body" "credential:item"))
             (resolved nil)
             (calls nil)
             (requester
               (lambda (url &rest options)
                 (push (cons url options) calls)
                 (values "{\"ok\":true}" 200)))
             (resolver
               (lambda (reference)
                 (push reference resolved)
                 (cond
                   ((string= reference "credential:api") "api-secret")
                   ((string= reference "credential:body") "body-secret")
                   ((string= reference "credential:item") "item-secret"))))
             (service
               (funcall maker
                        :endpoint "http://127.0.0.1:5000"
                        :operations operations
                        :allowed-operations allowed-operations
                        :allowed-credential-references allowed-references
                        :credential-resolver resolver
                        :requester requester
                        :authorization-header "X-Star-API-Key"
                        :authorization-prefix "Key ")))
        (funcall service "public.get"
                 (jsown:parse "{\"enabled\":false,\"force\":true}")
                 '(:credential-reference "credential:denied"))
        (let* ((options (cdr (first calls)))
               (headers (getf options :headers))
               (parameters (getf options :parameters)))
          (check (null resolved)
                 "A public operation resolved a configured credential.")
          (check (not (assoc "authorization" headers :test #'string-equal))
                 "A public operation received an authorization header.")
          (check (not (assoc "X-Star-API-Key" headers :test #'string-equal))
                 "A public operation received the configured API header.")
          (check (not (assoc "X-Star-Bootstrap-Secret" headers
                             :test #'string-equal))
                 "A public operation received a bootstrap secret header.")
          (check (string= "false" (cdr (assoc "enabled" parameters
                                               :test #'string=)))
                 "A false query boolean was not encoded as lowercase false.")
          (check (string= "true" (cdr (assoc "force" parameters
                                              :test #'string=)))
                 "A true query boolean was not encoded as lowercase true."))
        (funcall service "bootstrap.post" (jsown:parse "{}")
                 '(:credential-reference "credential:api"))
        (let ((headers (getf (cdr (first calls)) :headers)))
          (check (string= "api-secret"
                          (cdr (assoc "X-Star-Bootstrap-Secret" headers
                                      :test #'string-equal)))
                 "A bootstrap operation omitted its raw bootstrap header.")
          (check (not (assoc "X-Star-API-Key" headers :test #'string-equal))
                 "A bootstrap operation received the configured API header."))
        (funcall service "secure.post"
                 (jsown:parse
                  "{\"payload\":{\"password\":\"credential:body\",\"visible\":\"plain\"},\"items\":[{\"token\":\"credential:item\"}]}")
                 '(:credential-reference "credential:api"))
        (let* ((options (cdr (first calls)))
               (headers (getf options :headers))
               (body (jsown:parse (getf options :content)))
               (payload (jsown:val body "payload"))
               (items (jsown:val body "items"))
               (item (first (test-array-values items))))
          (check (string= "Key api-secret"
                          (cdr (assoc "X-Star-API-Key" headers
                                      :test #'string-equal)))
                 "An authenticated operation omitted configured authorization.")
          (check (string= "body-secret"
                          (jsown:val payload "password"))
                 "A nested writeOnly request credential was not resolved.")
          (check (string= "plain"
                          (jsown:val payload "visible"))
                 "A non-secret nested request value changed.")
          (check (string= "item-secret"
                          (jsown:val item "token"))
                 "A secret request credential inside an array was not resolved."))
        (funcall service "admin.get" (jsown:parse "{}")
                 '(:credential-reference "credential:api"))
        (check (string= "Key api-secret"
                        (cdr (assoc "X-Star-API-Key"
                                    (getf (cdr (first calls)) :headers)
                                    :test #'string-equal)))
               "An administrator operation omitted configured authorization.")
        (let ((resolver-called nil)
              (requester-called nil))
          (let ((denied-service
                  (funcall maker
                           :endpoint "http://127.0.0.1:5000"
                           :operations operations
                           :allowed-operations '("secure.post")
                           :allowed-credential-references '("credential:api")
                           :credential-resolver
                           (lambda (reference)
                             (declare (ignore reference))
                             (setf resolver-called t)
                             "must-not-resolve")
                           :requester
                           (lambda (&rest arguments)
                             (declare (ignore arguments))
                             (setf requester-called t)
                             (values "{}" 200)))))
            (check (signals-p
                    'error
                    (lambda ()
                      (funcall denied-service "secure.post"
                               (jsown:parse
                                "{\"payload\":{\"password\":\"credential:denied\"}}")
                               '(:credential-reference "credential:api"))))
                   "A denied nested secret reference reached dispatch.")
            (check (not resolver-called)
                   "A denied nested secret reference reached the resolver.")
            (check (not requester-called)
                   "A denied nested secret reference reached the network.")))
        (let ((resolver-called nil)
              (requester-called nil))
          (let ((unknown-service
                  (funcall maker
                           :endpoint "http://127.0.0.1:5000"
                           :operations operations
                           :allowed-operations '("unknown.get")
                           :allowed-credential-references '("credential:api")
                           :credential-resolver
                           (lambda (reference)
                             (declare (ignore reference))
                             (setf resolver-called t)
                             "must-not-resolve")
                           :requester
                           (lambda (&rest arguments)
                             (declare (ignore arguments))
                             (setf requester-called t)
                             (values "{}" 200)))))
            (check (signals-p
                    'error
                    (lambda ()
                      (funcall unknown-service "unknown.get"
                               (jsown:parse
                                "{\"token\":\"credential:api\"}")
                               '(:credential-reference "credential:api"))))
                   "An operation with unknown authority reached dispatch.")
            (check (not resolver-called)
                   "Unknown authority resolved a credential.")
            (check (not requester-called)
                   "Unknown authority reached the network.")))))))

(defun run-fbp-tests ()
  (dolist (test '(test-validation-and-iip
                  test-round-trip
                  test-invalid-port
                  test-sandbox-denial
                  test-lossless-atomic-backpressure
                  test-fanout-budget-counts-deliveries
                  test-fixed-worker-pool-is-bounded-and-reused
                  test-worker-failure-stops-and-drains-pool
                  test-worker-pool-start-failure-rolls-back
                  test-scheduler-failure-stops-and-joins-pool
                  test-self-trust-is-rejected
                  test-literal-secret-is-rejected
                  test-profile-values-are-inert
                  test-installer-no-secret
                  test-manifest-node-dispatch-when-control-loaded
                  test-starintel-adapter-authority-secrets-and-query-booleans))
    (funcall test))
  (format t "~&Quasar FBP: 16 tests passed.~%")
  t)
