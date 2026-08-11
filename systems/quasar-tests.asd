(asdf:defsystem "quasar-tests"
  :description "Quasar control-plane tests."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.2.0"
  :depends-on ("quasar-control"
               "quasar-starlang")
  :serial t
  :pathname "../control-plane/tests/"
  :components ((:file "control-plane-tests")
               (:file "workspace-integrity-tests")
               (:file "melissa-tests")
               (:file "melissa-restart-tests"))
  :perform (test-op (operation component)
             (declare (ignore operation component))
             (uiop:symbol-call :quasar.tests :run-tests)
             (funcall (find-symbol "RUN-WORKSPACE-INTEGRITY-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-MELISSA-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-MELISSA-RESTART-TESTS" "QUASAR.TESTS"))))
