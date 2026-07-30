(asdf:defsystem "quasar-web"
  :description "Quasar CLOG host and WebSocket bridge."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.2.0"
  :depends-on ("quasar-control"
               "quasar-starlang"
               "bordeaux-threads"
               "clog"
               "websocket-driver")
  :serial t
  :pathname "../control-plane/src/"
  :components ((:file "websocket-server")
               (:file "clog-host")
               (:file "main"))
  :in-order-to ((test-op (test-op "quasar-tests"))))
