(in-package #:quasar.fbp.control)

(defvar *workflow-runtimes* (make-hash-table :test #'equal))
(defvar *workflow-lock* (bt:make-lock "quasar-fbp-manager"))

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
  ;; Privileged services are injected by trusted init code. The runtime fails
  ;; closed when a graph requests a service that was not registered.
  nil)

(defun start-result (source)
  (let* ((network (compile-network (read-network source)))
         (id (quasar.fbp:network-id network))
         (runtime (make-runtime network :services (services-for-network network))))
    (bt:with-lock-held (*workflow-lock*)
      (let ((old (gethash id *workflow-runtimes*)))
        (when old (stop-runtime old))
        (setf (gethash id *workflow-runtimes*) runtime)))
    (start-runtime runtime)
    (quasar.protocol:json-object
     (cons "id" id)
     (cons "status" "starting"))))

(defun runtime-for (id)
  (or (gethash id *workflow-runtimes*)
      (error 'quasar.protocol:quasar-error
             :code "fbp.run-not-found"
             :message (format nil "Workflow run ~A does not exist." id)
             :details (quasar.protocol:empty-object))))

(defun status-result (id)
  (let ((runtime (runtime-for id)))
    (quasar.protocol:json-object
     (cons "id" id)
     (cons "status" (string-downcase (symbol-name (runtime-status runtime))))
     (cons "trace" (json-value (reverse (runtime-trace runtime)))))))

(defun stop-result (id)
  (let ((runtime (runtime-for id)))
    (stop-runtime runtime)
    (status-result id)))

(defun deployment-result (source apply-p)
  (let* ((network (read-network source))
         (plan (automation-plan network)))
    (when apply-p (apply-automation-plan plan :execute-commands t))
    (json-value plan)))

(defun profile-result (payload apply-p)
  (let* ((endpoint (quasar.protocol:json-value payload "endpoint"))
         (reference (or (quasar.protocol:json-value payload "credentialReference")
                        "credential:starintel-api"))
         (shell-name (or (quasar.protocol:json-value payload "shell") "sh"))
         (plan (profile-plan :endpoint endpoint
                             :credential-reference reference
                             :shell (if (string= shell-name "bash") :bash :sh))))
    (when apply-p (apply-profile-plan plan))
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
     (declare (ignore envelope))
     (translate-fbp-error
      (lambda () (start-result (payload-string payload "source"))))))
  (quasar.control-plane:register-command
   plane "fbp.run.stop"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (stop-result (payload-string payload "id"))))
  (quasar.control-plane:register-command
   plane "fbp.run.status"
   (lambda (payload envelope)
     (declare (ignore envelope))
     (status-result (payload-string payload "id"))))
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
