(asdf:defsystem "quasar-fbp"
  :description "Morrison-style flow-based programming runtime for Quasar."
  :author "lost-rob0t"
  :license "AGPL-3.0-only"
  :version "0.1.0"
  :serial t
  :pathname "../control-plane/src/fbp/"
  :depends-on ("bordeaux-threads" "jsown" "uiop")
  :components ((:file "packages")
               (:file "model")
               (:file "dsl")
               (:file "sandbox")
               (:file "runtime")
               (:file "builtins")
               (:file "installer")))

