(asdf:defsystem "quasar-starlang"
  :description "Quasar StarLang restricted adapter."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.2.0"
  :depends-on ("quasar-control")
  :serial t
  :pathname "../control-plane/src/"
  :components ((:file "starlang-adapter"))
  :in-order-to ((test-op (test-op "quasar-tests"))))
