(in-package #:quasar.fbp)

(defparameter +dangerous-capabilities+
  '(:process :shell :filesystem-write :network :ffi :raw-lisp))

(defun ensure-runtime-capabilities (network)
  "Fail closed when a graph asks for trusted in-process code without permission."
  (let ((policy (network-policy network)))
    (when (and (some (lambda (capability)
                       (member capability +dangerous-capabilities+))
                     (sandbox-policy-capabilities policy))
               (not (sandbox-policy-trusted-code-p policy)))
      (error 'sandbox-denied
             :code "fbp.untrusted-dangerous-capability"
             :message "Dangerous capabilities require an explicitly trusted graph."))
    policy))

(defun limit-value (policy key default)
  (or (getf (sandbox-policy-limits policy) key) default))

