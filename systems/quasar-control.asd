(asdf:defsystem "quasar-control"
  :description "Quasar Common Lisp control plane: protocol, workspace, Tek9 store, commands, actors."
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
               "sento"
               "tek9")
  :components ((:file "packages")
               (:file "protocol")
               (:file "phase2-protocol")
               (:file "workspace")
               (:file "persistence-plan")
               (:file "store")
               (:file "store-maintenance")
               (:file "phase2-store-core")
               (:file "phase2-store-page-fix")
               (:file "phase2-stage-write")
               (:file "phase2-promotion")
               (:file "phase2-stage-cleanup")
               (:file "phase2-store-reads")
               (:file "mutation-store")
               (:file "mutation-context-core")
               (:file "mutation-context-hydration")
               (:file "mutation-context-operations")
               (:file "mutation-execution")
               (:file "control-plane")
               (:file "phase2-control-plane")
               (:file "phase2-hardening")
               (:file "phase2-read-hardening")
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
               (:file "actors/melissa/bridge")
               ;; Loaded last so diagnostics wrap the final async-aware
               ;; control-plane dispatch implementation.
               (:file "debug-logging"))
  :in-order-to ((test-op (test-op "quasar-tests"))))