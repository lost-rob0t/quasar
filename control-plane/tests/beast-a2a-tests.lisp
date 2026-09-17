(defpackage #:quasar.fbp.beast-a2a-tests
  (:use #:cl #:quasar.fbp)
  (:export #:run-beast-a2a-tests))

(in-package #:quasar.fbp.beast-a2a-tests)

(defvar *calls* nil)

(defun check (value format-control &rest arguments)
  (unless value
    (error (apply #'format nil format-control arguments))))

(defun signals-p (type thunk)
  (handler-case (progn (funcall thunk) nil)
    (error (condition) (typep condition type))))

(defun a2a-network (&key (capabilities '(:a2a-worker)))
  (make-network
   :id "a2a-worker-test"
   :policy (make-sandbox-policy :capabilities capabilities)
   :components
   (list (make-component-spec :id "worker"
                              :type "starintel.a2a/worker"
                              :config '(:worker "gov-catalog")))
   :iips
   (list (make-iip-spec :value '(:target "fixture.local")
                        :to "worker" :in "task"))))

(defun test-a2a-worker-dispatches-through-host-service ()
  (setf *calls* nil)
  (let* ((service
           (lambda (worker task config)
             (push (list :worker worker :task task :config config) *calls*)
             (list :accepted t :worker worker)))
         (runtime
           (make-runtime
            (a2a-network)
            :grants '(:a2a-worker)
            :services (list :a2a-worker service))))
    (check (= 1 (step-runtime runtime))
           "The A2A worker activation did not run exactly once.")
    (check (= 1 (length *calls*))
           "Expected one host-owned A2A dispatch, got ~D." (length *calls*))
    (let ((call (first *calls*)))
      (check (string= "gov-catalog" (getf call :worker))
             "The worker id was not preserved.")
      (check (equal '(:target "fixture.local") (getf call :task))
             "The A2A task payload changed before host dispatch."))))

(defun test-a2a-worker-cannot-self-grant-capability ()
  (check
   (signals-p 'sandbox-denied
              (lambda ()
                (make-runtime (a2a-network) :services
                              (list :a2a-worker (lambda (&rest args)
                                                  (declare (ignore args)))))))
   "An A2A workflow ran without a host capability grant."))

(defun repository-root ()
  (or (uiop:getenv "QUASAR_REPOSITORY_ROOT")
      (namestring
       (truename
        (merge-pathnames "../../"
                         (asdf:system-source-directory "quasar-fbp-tests"))))))

(defun starter-path (name)
  (merge-pathnames name (pathname (repository-root))))

(defun test-bundled-beast-workflows-parse-and-validate ()
  (dolist (relative '("example_configs/beast-local-government.lisp"
                      "example_configs/beast-domain-recon.lisp"
                      "example_configs/beast-auto-dig-research.lisp"))
    (let* ((source (uiop:read-file-string (starter-path relative)))
           (network (read-network source)))
      (check (member :a2a-worker
                     (sandbox-policy-capabilities (network-policy network)))
             "~A does not request the A2A worker capability." relative)
      (check (plusp (length (network-components network)))
             "~A has no components." relative)
      (validate-network network))))

(defun run-beast-a2a-tests ()
  (dolist (test '(test-a2a-worker-dispatches-through-host-service
                  test-a2a-worker-cannot-self-grant-capability
                  test-bundled-beast-workflows-parse-and-validate))
    (funcall test))
  (format t "~&Quasar Beast A2A: 3 tests passed.~%")
  t)
