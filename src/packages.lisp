(defpackage #:quasar.protocol
  (:use #:cl)
  (:export
   #:+protocol-version+
   #:protocol-error
   #:decode-command
   #:encode-event
   #:encode-result
   #:encode-error
   #:json-object
   #:json-array
   #:json-value))

(defpackage #:quasar.workspace
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value)
  (:export
   #:workspace
   #:make-workspace
   #:workspace-id
   #:workspace-revision
   #:workspace-snapshot
   #:apply-workspace-operation))

(defpackage #:quasar.control-plane
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode-event
                #:encode-result
                #:encode-error
                #:json-object
                #:json-array
                #:json-value)
  (:import-from #:quasar.workspace
                #:make-workspace
                #:workspace-snapshot
                #:apply-workspace-operation)
  (:export
   #:control-plane
   #:make-control-plane
   #:start-control-plane
   #:stop-control-plane
   #:register-command
   #:submit-command
   #:control-plane-capabilities
   #:control-plane-workspace))

(defpackage #:quasar.starlang
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value)
  (:import-from #:quasar.control-plane
                #:register-command)
  (:export
   #:install-starlang-commands
   #:starlang-available-p))

(defpackage #:quasar.ui
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode-event
                #:encode-error
                #:json-object)
  (:import-from #:quasar.control-plane
                #:submit-command)
  (:export
   #:*frontend-url*
   #:*last-session*
   #:start-ui
   #:stop-ui
   #:broadcast-event))

(defpackage #:quasar.app
  (:use #:cl)
  (:import-from #:quasar.control-plane
                #:make-control-plane
                #:start-control-plane
                #:stop-control-plane)
  (:import-from #:quasar.starlang
                #:install-starlang-commands)
  (:import-from #:quasar.ui
                #:start-ui
                #:stop-ui)
  (:export
   #:*control-plane*
   #:start
   #:stop
   #:main))

(defpackage #:quasar.tests
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode-result)
  (:import-from #:quasar.workspace
                #:make-workspace
                #:workspace-revision
                #:workspace-snapshot
                #:apply-workspace-operation)
  (:export #:run-tests))
