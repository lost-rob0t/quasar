(asdf:defsystem "quasar-control"
  :description "Quasar Common Lisp control plane: protocol, workspace, store, commands, actors."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.2.0"
  :serial t
  :pathname "../control-plane/src/"
  :depends-on ("babel"
               "bordeaux-threads"
               "dexador"
               "jsown"
               "quri"
               "sento")
  :components ((:file "packages")
               (:file "protocol")
               (:file "workspace")
               (:file "store")
               (:file "control-plane")
               (:file "actors/melissa/packages")
               (:file "actors/melissa/async-control-plane")
               (:file "actors/melissa/messages")
               (:file "actors/melissa/entity")
               (:file "actors/melissa/transport-util")
               (:file "actors/melissa/transport")
               (:file "actors/melissa/forwarder")
               (:file "actors/melissa/normalize")
               (:file "actors/melissa/lookup")
               (:file "actors/melissa/router")
               (:file "actors/melissa/supervisor")
               (:file "actors/melissa/bridge"))
  :in-order-to ((test-op (test-op "quasar-tests"))))
