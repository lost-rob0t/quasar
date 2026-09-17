(in-package #:quasar.fbp)

(eval-when (:compile-toplevel :load-toplevel :execute)
  (defun dsl-name (value)
    (string-downcase
     (etypecase value
       (string value)
       (symbol (symbol-name value)))))

  (defun dsl-port (form)
    (destructuring-bind (name &key schema (required t) array) form
      `(make-port-spec :name ,(dsl-name name)
                       :schema ',schema
                       :required-p ,required
                       :array-p ,array)))

  (defun dsl-component (form)
    (destructuring-bind (tag id type &rest options) form
      (declare (ignore tag))
      `(make-component-spec :id ,(dsl-name id)
                            :type ,(dsl-name type)
                            :config ',(getf options :config))))

  (defun dsl-connection (form)
    (destructuring-bind (tag from out to in &key (capacity 16)) form
      (declare (ignore tag))
      `(make-connection-spec :from ,(dsl-name from)
                             :out ,(dsl-name out)
                             :to ,(dsl-name to)
                             :in ,(dsl-name in)
                             :capacity ,capacity)))

  (defun dsl-iip (form)
    (destructuring-bind (tag value to in) form
      (declare (ignore tag))
      `(make-iip-spec :value ',value :to ,(dsl-name to) :in ,(dsl-name in)))))

(defmacro define-node (id options arguments &body body)
  "Define a trusted registered component with declared ports and capabilities.

Example:
  (define-node demo/upcase
      (:label \"Uppercase\" :category \"text\"
       :inputs ((in :schema (:type \"string\")))
       :outputs ((out :schema (:type \"string\")))
       :capabilities ())
      (inputs context)
    (declare (ignore context))
    (list (cons \"out\" (list (string-upcase (cdr (assoc \"in\" inputs
                                                    :test #'string=)))))))"
  (destructuring-bind (&key label (category "custom") inputs outputs
                            capabilities config-schema)
      options
    `(register-node-type
      (make-node-type
       :id ,(dsl-name id)
       :label ,(or label (string-capitalize (substitute #\Space #\- (dsl-name id))))
       :category ,category
       :inputs (list ,@(mapcar #'dsl-port inputs))
       :outputs (list ,@(mapcar #'dsl-port outputs))
       :capabilities ',capabilities
       :config-schema ',config-schema
       :processor (lambda ,arguments ,@body))
      :replace t)))

(defmacro define-network (id options &body forms)
  "Define a canonical FBP network using ordinary, inspectable Lisp forms.

Body forms are (:component ID TYPE :config PLIST),
(:connect FROM OUT TO IN :capacity N), and (:iip VALUE TO IN)."
  (let ((components (remove :component forms :key #'first :test-not #'eq))
        (connections (remove :connect forms :key #'first :test-not #'eq))
        (iips (remove :iip forms :key #'first :test-not #'eq)))
    `(defparameter ,id
       (make-network
        :id ,(dsl-name id)
        :version ,(or (getf options :version) "1")
        :kind ,(or (getf options :kind) :workflow)
        :enabled-at-login-p ,(getf options :enabled-at-login)
        :components (list ,@(mapcar #'dsl-component components))
        :connections (list ,@(mapcar #'dsl-connection connections))
        :iips (list ,@(mapcar #'dsl-iip iips))
        :policy (make-sandbox-policy
                 :capabilities ',(getf options :capabilities)
                 :limits ',(getf options :limits)
                 :trusted-code-p ,(getf options :trusted-code))
        :metadata ',(getf options :metadata)))))

(defun network-to-form (network)
  (append
   (list 'define-network
         (intern (string-upcase (network-id network)) *package*)
         (list :version (network-version network)
               :kind (network-kind network)
               :enabled-at-login (network-enabled-at-login-p network)
               :capabilities (sandbox-policy-capabilities (network-policy network))
               :limits (sandbox-policy-limits (network-policy network))
               :trusted-code (sandbox-policy-trusted-code-p (network-policy network))
               :metadata (network-metadata network)))
   (mapcar (lambda (component)
             (list :component
                   (component-spec-id component)
                   (component-spec-type component)
                   :config (component-spec-config component)))
           (network-components network))
   (mapcar (lambda (connection)
             (list :connect
                   (connection-spec-from connection)
                   (connection-spec-out connection)
                   (connection-spec-to connection)
                   (connection-spec-in connection)
                   :capacity (connection-spec-capacity connection)))
           (network-connections network))
   (mapcar (lambda (iip)
             (list :iip (iip-spec-value iip) (iip-spec-to iip) (iip-spec-in iip)))
           (network-iips network))))

(defun network-to-lisp (network)
  "Emit deterministic ordinary Common Lisp. No reader macros are required."
  (let ((*print-pretty* t)
        (*print-readably* t)
        (*print-circle* nil))
    (with-output-to-string (stream)
      (pprint (network-to-form network) stream))))

(defun network-from-form (form)
  "Parse only the closed DEFINE-NETWORK data vocabulary; never EVAL the form."
  (unless (and (consp form)
               (symbolp (first form))
               (string-equal (symbol-name (first form)) "DEFINE-NETWORK"))
    (error 'validation-error :code "fbp.invalid-dsl"
           :message "Expected a DEFINE-NETWORK form."))
  (destructuring-bind (operator id options &rest body) form
    (declare (ignore operator))
    (unless (and (listp options)
                 (every (lambda (entry)
                          (member (first entry) '(:component :connect :iip)))
                        body))
      (error 'validation-error :code "fbp.invalid-dsl"
             :message "The network contains a form outside the closed FBP vocabulary."))
    (let ((components nil) (connections nil) (iips nil))
      (dolist (entry body)
        (ecase (first entry)
          (:component
           (destructuring-bind (tag component-id type &key config) entry
             (declare (ignore tag))
             (push (make-component-spec :id (canonical-name component-id)
                                        :type (canonical-name type)
                                        :config config)
                   components)))
          (:connect
           (destructuring-bind (tag from out to in &key (capacity 16)) entry
             (declare (ignore tag))
             (push (make-connection-spec :from (canonical-name from)
                                         :out (canonical-name out)
                                         :to (canonical-name to)
                                         :in (canonical-name in)
                                         :capacity capacity)
                   connections)))
          (:iip
           (destructuring-bind (tag value to in) entry
             (declare (ignore tag))
             (push (make-iip-spec :value value :to (canonical-name to)
                                  :in (canonical-name in))
                   iips)))))
      (make-network
       :id (canonical-name id)
       :version (or (getf options :version) "1")
       :kind (or (getf options :kind) :workflow)
       :enabled-at-login-p (getf options :enabled-at-login)
       :components (nreverse components)
       :connections (nreverse connections)
       :iips (nreverse iips)
       :policy (make-sandbox-policy
                :capabilities (copy-list (getf options :capabilities))
                :limits (copy-list (getf options :limits))
                :trusted-code-p (getf options :trusted-code))
       :metadata (copy-list (getf options :metadata))))))

(defun read-network (source)
  (let ((*read-eval* nil))
    (multiple-value-bind (form position)
        (read-from-string source nil :eof)
      (when (eq form :eof)
        (error 'validation-error :code "fbp.invalid-dsl" :message "Empty FBP source."))
      (unless (every (lambda (character) (find character " \t\r\n"))
                     (subseq source position))
        (error 'validation-error :code "fbp.invalid-dsl"
               :message "Trailing forms are not allowed."))
      (validate-network (network-from-form form)))))
