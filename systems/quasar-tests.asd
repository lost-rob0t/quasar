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
               (:file "tek9-store-tests")
               (:file "tek9-store-adversarial-tests")
               (:file "tek9-store-maintenance-tests")
               (:file "phase2-test-compat")
               (:file "phase2-storage-spec-tests")
               (:file "phase2-adversarial-v2")
               (:file "phase2-adversarial-v2-regression-fix")
               (:file "phase2-protocol-tests")
               (:file "phase2-large-corpus-tests")
               (:file "phase3-record-bounded-mutation-tests")
               (:file "phase3-adversarial-tests")
               (:file "melissa-tests")
               (:file "melissa-restart-tests")
               (:file "debug-logging-tests"))
  :perform (test-op (operation component)
             (declare (ignore operation component))
             (uiop:symbol-call :quasar.tests :run-tests)
             (funcall (find-symbol "RUN-WORKSPACE-INTEGRITY-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-TEK9-STORE-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-TEK9-STORE-ADVERSARIAL-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-TEK9-STORE-MAINTENANCE-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-PHASE2-STORAGE-SPEC-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-PHASE2-ADVERSARIAL-V2-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-PHASE2-PROTOCOL-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-PHASE2-LARGE-CORPUS-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-PHASE3-RECORD-BOUNDED-MUTATION-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-PHASE3-ADVERSARIAL-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-MELISSA-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-MELISSA-RESTART-TESTS" "QUASAR.TESTS"))
             (funcall (find-symbol "RUN-DEBUG-LOGGING-TESTS" "QUASAR.TESTS"))))