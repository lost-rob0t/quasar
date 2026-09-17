(in-package #:quasar.fbp)

(defconstant +model-version+ "quasar.fbp.v1")

(define-condition fbp-error (error)
  ((code :initarg :code :reader fbp-error-code)
   (message :initarg :message :reader fbp-error-message)
   (details :initarg :details :initform nil :reader fbp-error-details))
  (:report (lambda (condition stream)
             (format stream "~A: ~A"
                     (fbp-error-code condition)
                     (fbp-error-message condition)))))

(define-condition validation-error (fbp-error) ())
(define-condition backpressure (fbp-error) ())
(define-condition sandbox-denied (fbp-error) ())

(defstruct port-spec
  (name "in" :type string)
  schema
  (required-p t)
  (array-p nil))

(defstruct node-type
  (id "" :type string)
  (label "" :type string)
  (category "core" :type string)
  (inputs nil :type list)
  (outputs nil :type list)
  (capabilities nil :type list)
  config-schema
  processor)

(defstruct component-spec
  (id "" :type string)
  (type "" :type string)
  (config nil :type list))

(defstruct connection-spec
  (from "" :type string)
  (out "out" :type string)
  (to "" :type string)
  (in "in" :type string)
  (capacity 16 :type integer))

(defstruct iip-spec
  value
  (to "" :type string)
  (in "in" :type string))

(defstruct sandbox-policy
  (capabilities nil :type list)
  (limits nil :type list)
  (trusted-code-p nil))

(defstruct network
  (id "" :type string)
  (version "1" :type string)
  (kind :workflow)
  (enabled-at-login-p nil)
  (components nil :type list)
  (connections nil :type list)
  (iips nil :type list)
  (policy (make-sandbox-policy))
  (metadata nil :type list))

(defvar *node-types* (make-hash-table :test #'equal))

(defun canonical-name (value)
  (string-downcase
   (etypecase value
     (string value)
     (symbol (symbol-name value)))))

(defun register-node-type (node-type &key (replace nil))
  (let ((id (canonical-name (node-type-id node-type))))
    (when (and (gethash id *node-types*) (not replace))
      (error 'validation-error
             :code "fbp.duplicate-node-type"
             :message (format nil "Node type ~A is already registered." id)))
    (setf (node-type-id node-type) id
          (gethash id *node-types*) node-type)
    node-type))

(defun unregister-node-type (id)
  (remhash (canonical-name id) *node-types*))

(defun find-node-type (id &key (errorp t))
  (or (gethash (canonical-name id) *node-types*)
      (when errorp
        (error 'validation-error
               :code "fbp.unknown-node-type"
               :message (format nil "Unknown node type ~A." id)))))

(defun all-node-types ()
  (sort (loop for value being the hash-values of *node-types* collect value)
        #'string< :key #'node-type-id))

(defun clear-node-registry ()
  (clrhash *node-types*))

(defun port-named (ports name)
  (find (canonical-name name) ports :key #'port-spec-name :test #'string=))

(defun ensure-unique (values code label)
  (let ((seen (make-hash-table :test #'equal)))
    (dolist (value values)
      (when (gethash value seen)
        (error 'validation-error :code code
               :message (format nil "Duplicate ~A ~A." label value)))
      (setf (gethash value seen) t))))

(defun policy-allows-p (policy capability)
  (or (null capability)
      (member :all (sandbox-policy-capabilities policy))
      (member capability (sandbox-policy-capabilities policy) :test #'equal)))

(defun validate-network (network)
  "Validate a network without evaluating component source or performing I/O."
  (unless (and (stringp (network-id network)) (plusp (length (network-id network))))
    (error 'validation-error :code "fbp.invalid-network-id"
           :message "A network requires a non-empty string id."))
  (ensure-unique (mapcar #'component-spec-id (network-components network))
                 "fbp.duplicate-component" "component")
  (let ((components (make-hash-table :test #'equal))
        (incoming (make-hash-table :test #'equal)))
    (dolist (component (network-components network))
      (let ((type (find-node-type (component-spec-type component))))
        (setf (gethash (component-spec-id component) components) component)
        (dolist (capability (node-type-capabilities type))
          (unless (policy-allows-p (network-policy network) capability)
            (error 'sandbox-denied :code "fbp.capability-denied"
                   :message (format nil "Component ~A requires denied capability ~A."
                                    (component-spec-id component) capability)
                   :details (list :component (component-spec-id component)
                                  :capability capability))))))
    (labels ((component-type-for (id)
               (let ((component (gethash id components)))
                 (unless component
                   (error 'validation-error :code "fbp.unknown-component"
                          :message (format nil "Unknown component ~A." id)))
                 (find-node-type (component-spec-type component))))
             (claim-input (component port source)
               (let ((key (list component port)))
                 (when (gethash key incoming)
                   (error 'validation-error :code "fbp.multiple-producers"
                          :message (format nil "Input ~A.~A has more than one producer."
                                           component port)))
                 (setf (gethash key incoming) source))))
      (dolist (connection (network-connections network))
        (unless (plusp (connection-spec-capacity connection))
          (error 'validation-error :code "fbp.invalid-capacity"
                 :message "Connection capacity must be positive."))
        (let ((from-type (component-type-for (connection-spec-from connection)))
              (to-type (component-type-for (connection-spec-to connection))))
          (unless (port-named (node-type-outputs from-type) (connection-spec-out connection))
            (error 'validation-error :code "fbp.unknown-output"
                   :message (format nil "Unknown output ~A.~A."
                                    (connection-spec-from connection)
                                    (connection-spec-out connection))))
          (unless (port-named (node-type-inputs to-type) (connection-spec-in connection))
            (error 'validation-error :code "fbp.unknown-input"
                   :message (format nil "Unknown input ~A.~A."
                                    (connection-spec-to connection)
                                    (connection-spec-in connection))))
          (claim-input (connection-spec-to connection)
                       (connection-spec-in connection) :connection)))
      (dolist (iip (network-iips network))
        (let ((type (component-type-for (iip-spec-to iip))))
          (unless (port-named (node-type-inputs type) (iip-spec-in iip))
            (error 'validation-error :code "fbp.unknown-input"
                   :message (format nil "Unknown IIP input ~A.~A."
                                    (iip-spec-to iip) (iip-spec-in iip))))
          (claim-input (iip-spec-to iip) (iip-spec-in iip) :iip)))
      (dolist (component (network-components network))
        (let ((type (find-node-type (component-spec-type component))))
          (dolist (port (node-type-inputs type))
            (when (and (port-spec-required-p port)
                       (null (gethash (list (component-spec-id component)
                                            (port-spec-name port))
                                      incoming)))
              (error 'validation-error :code "fbp.unconnected-input"
                     :message (format nil "Required input ~A.~A is not connected."
                                      (component-spec-id component)
                                      (port-spec-name port))))))))
    network))

(defun compile-network (network)
  "Return the validated canonical network. Runtime compilation is side-effect free."
  (validate-network network))

(defun node-descriptor (type)
  (labels ((port (value)
             (list :name (port-spec-name value)
                   :schema (port-spec-schema value)
                   :required (port-spec-required-p value)
                   :array (port-spec-array-p value))))
    (list :id (node-type-id type)
          :label (node-type-label type)
          :category (node-type-category type)
          :inputs (mapcar #'port (node-type-inputs type))
          :outputs (mapcar #'port (node-type-outputs type))
          :capabilities (copy-list (node-type-capabilities type))
          :config-schema (node-type-config-schema type))))

(defun node-catalog ()
  (mapcar #'node-descriptor (all-node-types)))
