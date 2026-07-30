(in-package #:quasar.control-plane)

(defclass control-plane ()
  ((actor-system :initform nil :accessor control-plane-actor-system)
   (command-actor :initform nil :accessor control-plane-command-actor)
   (handlers :initform (make-hash-table :test #'equal)
             :reader control-plane-handlers)
   (workspace :initform (make-workspace)
              :reader control-plane-workspace)
   (started-p :initform nil :accessor control-plane-started-p)))

(defun make-control-plane ()
  (make-instance 'control-plane))

(defun register-command (plane name handler)
  (check-type name string)
  (check-type handler function)
  (setf (gethash name (control-plane-handlers plane)) handler)
  name)

(defun control-plane-capabilities (plane)
  (sort (loop for name being the hash-keys of (control-plane-handlers plane)
              collect name)
        #'string<))

(defun install-core-commands (plane)
  (register-command
   plane
   "system.capabilities"
   (lambda (payload)
     (declare (ignore payload))
     (apply #'json-array (control-plane-capabilities plane))))
  (register-command
   plane
   "workspace.snapshot"
   (lambda (payload)
     (declare (ignore payload))
     (workspace-snapshot (control-plane-workspace plane))))
  (register-command
   plane
   "workspace.apply"
   (lambda (payload)
     (apply-workspace-operation
      (control-plane-workspace plane)
      (json-value payload "operation"))))
  plane)

(defun dispatch-message (plane message)
  (destructuring-bind (&key id command payload reply) message
    (let ((handler (gethash command (control-plane-handlers plane))))
      (handler-case
          (if handler
              (funcall reply (encode-result id (funcall handler payload)))
              (funcall reply
                       (encode-error id
                                     "unknown-command"
                                     (format nil "Unknown command ~A." command))))
        (error (condition)
          (funcall reply
                   (encode-error id
                                 "command-failed"
                                 (princ-to-string condition))))))))

(defun start-control-plane (plane)
  (unless (control-plane-started-p plane)
    (install-core-commands plane)
    (setf (control-plane-actor-system plane)
          (sento.actor-system:make-actor-system))
    (setf (control-plane-command-actor plane)
          (sento.actor:actor-of
           (control-plane-actor-system plane)
           :name "quasar-control-plane"
           :receive (lambda (message)
                      (dispatch-message plane message))))
    (setf (control-plane-started-p plane) t))
  plane)

(defun maybe-shutdown-actor-system (system)
  (let ((symbol (find-symbol "SHUTDOWN" "SENTO.ACTOR-SYSTEM")))
    (when (and symbol (fboundp symbol))
      (funcall symbol system))))

(defun stop-control-plane (plane)
  (when (control-plane-started-p plane)
    (maybe-shutdown-actor-system (control-plane-actor-system plane))
    (setf (control-plane-command-actor plane) nil
          (control-plane-actor-system plane) nil
          (control-plane-started-p plane) nil))
  t)

(defun submit-command (plane encoded reply)
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (multiple-value-bind (id command payload)
      (decode-command encoded)
    (sento.actor:tell
     (control-plane-command-actor plane)
     (list :id id
           :command command
           :payload payload
           :reply reply))
    id))
