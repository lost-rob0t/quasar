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

(defun check (value format-control &rest arguments)
  (unless value
    (error (apply #'format nil format-control arguments))))

(defun signals-p (type thunk)
  (handler-case (progn (funcall thunk) nil)
    (error (condition) (typep condition type))))

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
           "A literal StarIntel key was accepted in component config.")))

(defun test-profile-values-are-inert ()
  (check (signals-p 'validation-error
                    (lambda ()
                      (profile-plan :endpoint "http://127.0.0.1/$(touch-pwned)")))
         "A shell substitution was accepted in the endpoint.")
  (check (signals-p 'validation-error
                    (lambda ()
                      (profile-plan :credential-reference "star_sk_v1_raw")))
         "A raw key was accepted as a credential reference."))

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
    (check (and (search "ExecStart=" unit)
                (search " fbp-run --graph" unit))
           "The user unit does not invoke the packaged fbp-run entry point.")
    (check (search "STARINTEL_ENDPOINT=http://127.0.0.1:5000" unit)
           "The user unit omitted its StarIntel endpoint.")
    (check (search "QUASAR_STARINTEL_ALLOWED_OPERATIONS=" unit)
           "The user unit omitted its host-owned operation allowlist.")
    (check (search "LoadCredential=\"starintel-api:" unit)
           "The user unit omitted its systemd credential reference.")))

(defun test-manifest-node-dispatch-when-control-loaded ()
  (when (find-package "QUASAR.FBP.CONTROL")
    (let* ((manifest
             (jsown:parse
              "{\"schema\":\"starintel-client-manifest-v1\",\"operations\":[{\"operation_id\":\"documents.get\",\"method\":\"get\",\"path\":\"/documents/:id\",\"openapi_path\":\"/documents/{id}\",\"authority\":\"api-key\",\"scopes\":[\"documents:read\"],\"path_parameters\":[\"id\"],\"query_parameters\":[],\"request_schema\":null,\"responses\":[{\"status\":200,\"schema\":{\"type\":\"object\"}}]}],\"fbp_nodes\":[{\"id\":\"starintel.operation/documents.get\",\"component\":\"starintel.operation\",\"operation_id\":\"documents.get\",\"label\":\"Get document\",\"category\":\"StarIntel API\",\"inputs\":[{\"name\":\"id\",\"source\":\"path\",\"required\":true,\"schema\":{\"type\":\"string\"}}],\"outputs\":[{\"name\":\"status-200\",\"status\":200,\"schema\":{\"type\":\"object\"}}],\"config_schema\":{\"type\":\"object\",\"properties\":{\"operation\":{\"const\":\"documents.get\"},\"credential_reference\":{\"type\":\"string\"}}}}]}"))
           (called nil))
      (unwind-protect
           (multiple-value-bind (grants operations)
               (uiop:symbol-call :quasar.fbp.control
                                 :register-starintel-operation-nodes
                                 :manifest manifest
                                 :allowed-operations '("documents.get"))
             (let ((resolver-called nil)
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
                      "Dynamic operation processor lost its immutable operation id.")))
        (uiop:symbol-call :quasar.fbp.control :clear-starintel-operation-nodes)))))

(defun run-fbp-tests ()
  (dolist (test '(test-validation-and-iip
                  test-round-trip
                  test-invalid-port
                  test-sandbox-denial
                  test-lossless-atomic-backpressure
                  test-fanout-budget-counts-deliveries
                  test-self-trust-is-rejected
                  test-literal-secret-is-rejected
                  test-profile-values-are-inert
                  test-installer-no-secret
                  test-manifest-node-dispatch-when-control-loaded))
    (funcall test))
  (format t "~&Quasar FBP: 11 tests passed.~%")
  t)
