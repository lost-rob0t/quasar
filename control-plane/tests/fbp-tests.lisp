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
    (check (signals-p 'sandbox-denied (lambda () (validate-network network)))
           "A denied process capability passed validation.")))

(defun test-bounded-backpressure ()
  (let* ((runtime (make-runtime (basic-network :capacity 1)))
         (channel (find "copy" (quasar.fbp::runtime-channels runtime)
                        :key (lambda (value)
                               (connection-spec-from
                                (quasar.fbp::channel-spec value)))
                        :test #'string=)))
    (quasar.fbp::channel-push channel
                              (quasar.fbp::make-packet :value "occupied"))
    (check (signals-p 'backpressure
                      (lambda ()
                        (quasar.fbp::channel-push
                         channel (quasar.fbp::make-packet :value "overflow"))))
           "A bounded connection accepted overflow.")))

(defun test-installer-no-secret ()
  (let* ((secret "star_sk_v1_must_not_appear")
         (network (basic-network :enabled t))
         (plan (automation-plan network :graph-path #P"/tmp/basic.lisp"))
         (rendered (with-output-to-string (stream) (prin1 plan stream))))
    (check (not (search secret rendered)) "Installer plan leaked a secret.")
    (check (getf plan :enable) "Enabled automation did not request systemd enable.")))

(defun run-fbp-tests ()
  (dolist (test '(test-validation-and-iip
                  test-round-trip
                  test-invalid-port
                  test-sandbox-denial
                  test-bounded-backpressure
                  test-installer-no-secret))
    (funcall test))
  (format t "~&Quasar FBP: 6 tests passed.~%")
  t)
