(asdf:defsystem "quasar"
  :description "Quasar Common Lisp control plane and CLOG WebSocket host."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.1.0"
  :serial t
  :depends-on ("bordeaux-threads"
               "clog"
               "jsown"
               "sento")
  :components ((:file "src/packages")
               (:file "src/protocol")
               (:file "src/workspace")
               (:file "src/control-plane")
               (:file "src/starlang-adapter")
               (:file "src/clog-host")
               (:file "src/main"))
  :in-order-to ((test-op (test-op "quasar/tests"))))

(asdf:defsystem "quasar/tests"
  :description "Quasar control-plane tests."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :depends-on ("quasar")
  :serial t
  :components ((:file "tests/control-plane-tests"))
  :perform (test-op (operation component)
             (declare (ignore operation component))
             (uiop:symbol-call :quasar.tests :run-tests)))
