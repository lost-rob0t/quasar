(in-package #:quasar.control-plane)

(defvar *async-handler-tables* (make-hash-table :test #'eq))

(defun async-handler-table (plane)
  (or (gethash plane *async-handler-tables*)
      (setf (gethash plane *async-handler-tables*)
            (make-hash-table :test #'equal))))

(defun register-async-command (plane name handler)
  (check-type name string)
  (check-type handler function)
  (remhash name (control-plane-handlers plane))
  (setf (gethash name (async-handler-table plane)) handler)
  name)

(defun unregister-command (plane name)
  (check-type name string)
  (remhash name (control-plane-handlers plane))
  (let ((table (gethash plane *async-handler-tables*)))
    (when table
      (remhash name table)))
  name)

(defun control-plane-capabilities (plane)
  (let ((async (gethash plane *async-handler-tables*)))
    (sort
     (remove-duplicates
      (append
       (loop for name being the hash-keys of (control-plane-handlers plane)
             collect name)
       (when async
         (loop for name being the hash-keys of async collect name)))
      :test #'string=)
     #'string<)))

(defun dispatch-message (plane message)
  (destructuring-bind (&key envelope reply) message
    (let* ((id (quasar.protocol:command-envelope-id envelope))
           (command (quasar.protocol:command-envelope-command envelope))
           (payload (quasar.protocol:command-envelope-payload envelope))
           (handler (gethash command (control-plane-handlers plane)))
           (async-table (gethash plane *async-handler-tables*))
           (async-handler (and async-table (gethash command async-table))))
      (handler-case
          (cond
            (async-handler
             (funcall async-handler id payload envelope reply))
            (handler
             (funcall reply
                      (quasar.protocol:encode-result
                       id (funcall handler payload envelope))))
            (t
             (funcall reply
                      (quasar.protocol:encode-error
                       id "protocol.unknown-command"
                       (format nil "Unknown command ~A." command)
                       (quasar.protocol:empty-object)))))
        (quasar.protocol:quasar-error (condition)
          (funcall reply (quasar.protocol:quasar-error-to-envelope id condition)))
        (error (condition)
          (format *error-output* "~&[control-plane] unexpected error: ~A~%" condition)
          (funcall reply
                   (quasar.protocol:encode-error
                    id "control-plane.unavailable"
                    "The control plane could not process the command."
                    (quasar.protocol:empty-object))))))))

(defun clear-async-commands (plane)
  (remhash plane *async-handler-tables*)
  t)
