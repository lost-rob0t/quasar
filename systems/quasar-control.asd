(asdf:defsystem "quasar-control"
  :description "Quasar Common Lisp control plane: protocol, workspace, store, commands."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.2.0"
  :serial t
  :pathname "../control-plane/src/"
  :depends-on ("bordeaux-threads"
               "jsown"
               "sento")
  :components ((:file "packages")
               (:file "protocol")
               (:file "workspace")
               (:file "store")
               (:file "control-plane"))
  :in-order-to ((test-op (test-op "quasar-tests"))))
