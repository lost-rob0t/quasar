(defpackage #:quasar.autodig-control
  (:use #:cl)
  (:export
   #:auto-dig-runtime
   #:runtime-capabilities
   #:invoke-runtime
   #:install-runtime-commands))

(in-package #:quasar.autodig-control)

(defparameter +auto-dig-commands+
  '("autodig.status"
    "autodig.run.get"
    "autodig.run.list"
    "autodig.run.start"
    "autodig.run.pause"
    "autodig.run.resume"
    "autodig.run.stop"))

(defclass auto-dig-runtime () ()
  (:documentation
   "Adapter protocol for the owning Auto-Dig runtime.

Quasar exposes typed lifecycle commands, but does not own run persistence or
scheduling. Concrete runtimes must return only capabilities they actually
implement and allocate durable run IDs themselves."))

(defgeneric runtime-capabilities (runtime)
  (:documentation "Return the supported canonical Auto-Dig command names."))

(defmethod runtime-capabilities ((runtime auto-dig-runtime))
  (declare (ignore runtime))
  nil)

(defgeneric invoke-runtime (runtime command workspace-id payload)
  (:documentation
   "Invoke COMMAND for WORKSPACE-ID with PAYLOAD on the owning runtime."))

(defmethod invoke-runtime ((runtime auto-dig-runtime) command workspace-id payload)
  (declare (ignore runtime command workspace-id payload))
  (error 'quasar.protocol:quasar-error
         :code "autodig.capability-unavailable"
         :message "The requested Auto-Dig capability is unavailable."))

(defun canonical-capability-p (name)
  (and (stringp name)
       (member name +auto-dig-commands+ :test #'string=)))

(defun checked-runtime-capabilities (runtime)
  (let ((capabilities (runtime-capabilities runtime)))
    (unless (listp capabilities)
      (error 'quasar.protocol:quasar-error
             :code "autodig.invalid-runtime"
             :message "The Auto-Dig runtime returned an invalid capability set."))
    (dolist (name capabilities)
      (unless (canonical-capability-p name)
        (error 'quasar.protocol:quasar-error
               :code "autodig.invalid-runtime"
               :message "The Auto-Dig runtime advertised an unknown capability.")))
    (remove-duplicates capabilities :test #'string=)))

(defun envelope-workspace-id (envelope)
  (or (quasar.protocol:command-envelope-workspace envelope) "default"))

(defun install-runtime-commands (plane runtime)
  "Install only the canonical lifecycle commands supported by RUNTIME."
  (dolist (command (checked-runtime-capabilities runtime) plane)
    (let ((command-name command))
      (quasar.control-plane:register-command
       plane command-name
       (lambda (payload envelope)
         (invoke-runtime runtime
                         command-name
                         (envelope-workspace-id envelope)
                         payload))))))

(in-package #:quasar.control-plane)

(defun make-control-plane (&key
                             (store (quasar.store:make-memory-store))
                             auto-dig-runtime)
  "Create a control plane and install optional owning-runtime capabilities.

Auto-Dig commands are absent unless AUTO-DIG-RUNTIME explicitly advertises
support for them. The runtime remains the owner of lifecycle state and durable
run identifiers."
  (let ((plane (make-instance 'control-plane :store store)))
    (when auto-dig-runtime
      (quasar.autodig-control:install-runtime-commands plane auto-dig-runtime))
    plane))
