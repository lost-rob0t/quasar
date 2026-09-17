(asdf:defsystem "quasar-fbp-tests"
  :description "Deterministic tests for the Quasar FBP core."
  :license "AGPL-3.0-only"
  :depends-on ("quasar-fbp")
  :serial t
  :pathname "../control-plane/tests/"
  :components ((:file "fbp-tests"))
  :perform (test-op (operation component)
             (declare (ignore operation component))
             (uiop:symbol-call :quasar.fbp.tests :run-fbp-tests)))

