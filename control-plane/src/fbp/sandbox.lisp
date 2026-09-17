(in-package #:quasar.fbp)

(defparameter +dangerous-capabilities+
  '(:process :shell :filesystem-write :network :ffi :raw-lisp))

(defun network-required-capabilities (network)
  (remove-duplicates
   (loop for component in (network-components network)
         append (copy-list
                 (node-type-capabilities
                  (find-node-type (component-spec-type component)))))
   :test #'equal))

(defun ensure-runtime-capabilities (network grants)
  "Authorize component requirements against immutable host grants.

The graph may request capabilities for review, but can never grant them.  :ALL is
intentionally rejected even when supplied by a trusted caller."
  (when (member :all grants)
    (error 'sandbox-denied :code "fbp.wildcard-grant-forbidden"
           :message "Wildcard FBP capability grants are forbidden."))
  (dolist (capability (network-required-capabilities network))
    (unless (member capability grants :test #'equal)
      (error 'sandbox-denied :code "fbp.capability-denied"
             :message (format nil "The host did not grant required capability ~A."
                              capability)
             :details (list :capability capability))))
  grants)

(defun limit-value (policy key default)
  (or (getf (sandbox-policy-limits policy) key) default))
