(defpackage #:quasar.protocol
  (:use #:cl)
  (:export
   #:+protocol-version+
   #:quasar-error
   #:quasar-error-code
   #:quasar-error-message
   #:quasar-error-details
   #:make-quasar-error
   #:command-envelope
   #:command-envelope-id
   #:command-envelope-command
   #:command-envelope-payload
   #:command-envelope-client
   #:command-envelope-workspace
   #:make-command-envelope
   #:decode-command
   #:encode
   #:encode-event
   #:encode-result
   #:encode-error
   #:quasar-error-to-envelope
   #:json-object
   #:json-array
   #:json-value
   #:json-get
   #:object-p
   #:array-p
   #:object-keys
   #:object-set
   #:empty-object
   #:empty-array
   #:ensure-string
   #:ensure-object
   #:ensure-array
   #:ensure-object-id))

(defpackage #:quasar.store
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value)
  (:export
   #:workspace-store
   #:memory-store
   #:make-memory-store
   #:load-workspace
   #:save-workspace
   #:append-operation))

(defpackage #:quasar.workspace
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value
                #:empty-object
                 #:ensure-string
                 #:ensure-object
                 #:quasar-error)
  (:export
   #:workspace
   #:make-workspace
   #:workspace-id
   #:workspace-revision
   #:workspace-documents
   #:workspace-graphs
   #:workspace-settings
   #:workspace-graph
   #:workspace-snapshot
   #:graph-snapshot
   #:graph-node
   #:graph-edge
   #:graph-nodes
   #:graph-edges
   #:dispatch-operation
   #:commit-operations
   #:apply-document-create
   #:apply-document-update
   #:apply-document-delete
   #:apply-node-create
   #:apply-node-update
   #:apply-node-delete
   #:apply-edge-create
   #:apply-edge-update
   #:apply-edge-delete
   #:applied-op
   #:applied-op-event
   #:applied-op-result
   #:applied-op-inverse))

(defpackage #:quasar.control-plane
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode-event
                #:encode-result
                #:encode-error
                #:quasar-error-to-envelope
                #:json-object
                #:json-array
                #:json-value
                #:empty-object
                #:command-envelope
                #:command-envelope-id
                #:command-envelope-command
                #:command-envelope-payload
                #:command-envelope-workspace
                #:make-command-envelope)
  (:import-from #:quasar.workspace
                #:make-workspace
                #:workspace-id
                #:workspace-revision
                #:workspace-snapshot
                #:workspace-documents
                #:workspace-graphs
                #:workspace-settings
                #:workspace-graph
                #:graph-snapshot
                #:dispatch-operation
                #:commit-operations
                #:apply-document-create
                #:applied-op-event
                #:applied-op-result)
  (:import-from #:quasar.store
                #:make-memory-store
                #:load-workspace
                #:save-workspace
                #:append-operation)
  (:export
   #:control-plane
   #:make-control-plane
   #:start-control-plane
   #:stop-control-plane
   #:register-command
   #:submit-command
   #:submit-decoded
   #:subscribe
   #:unsubscribe
   #:broadcast-event
   #:control-plane-capabilities
   #:control-plane-workspaces
   #:control-plane-store))

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

(defpackage #:quasar.ws
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode
                #:encode-result
                #:encode-error
                #:quasar-error-to-envelope)
  (:import-from #:quasar.control-plane
                #:submit-command
                #:subscribe
                #:unsubscribe)
  (:export
   #:websocket-server
   #:make-websocket-server
   #:start-websocket-server
   #:stop-websocket-server))

(defpackage #:quasar.ui
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:encode
                #:encode-event
                #:encode-error
                #:json-object)
  (:import-from #:quasar.control-plane
                #:submit-command
                #:subscribe
                #:broadcast-event)
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
                #:stop-control-plane
                #:subscribe
                #:broadcast-event)
  (:import-from #:quasar.starlang
                #:install-starlang-commands)
  (:import-from #:quasar.ui
                #:start-ui
                #:stop-ui)
  (:import-from #:quasar.ws
                #:make-websocket-server
                #:start-websocket-server
                #:stop-websocket-server)
  (:export
   #:*control-plane*
   #:*websocket-server*
   #:start
   #:stop
   #:main))

(defpackage #:quasar.tests
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode-result
                #:encode
                #:json-object
                #:json-value
                #:quasar-error
                #:make-command-envelope)
  (:import-from #:quasar.workspace
                #:make-workspace
                #:workspace-revision
                #:workspace-snapshot
                #:dispatch-operation
                #:commit-operations
                #:graph-node
                #:graph-edge)
  (:import-from #:quasar.control-plane
                #:make-control-plane
                #:start-control-plane
                #:stop-control-plane
                #:submit-decoded)
  (:export #:run-tests))
