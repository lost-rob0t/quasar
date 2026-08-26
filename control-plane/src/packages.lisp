(defpackage #:quasar.protocol
  (:use #:cl)
  (:export
   #:+protocol-version+
   #:command-envelope
   #:command-envelope-id
   #:command-envelope-command
   #:command-envelope-payload
   #:command-envelope-metadata
   #:command-envelope-client
   #:command-envelope-workspace
   #:command-envelope-trace-id
   #:make-command-envelope
   #:decode-command
   #:encode
   #:encode-result
   #:encode-error
   #:encode-event
   #:quasar-error
   #:quasar-error-code
   #:quasar-error-message
   #:quasar-error-to-envelope
   #:json-object
   #:json-array
   #:json-array-p
   #:json-value
   #:empty-object
   #:object-set
   #:clone-json
   #:ensure-array
   #:ensure-string
   #:ensure-integer
   #:ensure-boolean))

(defpackage #:quasar.workspace
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-array-p
                #:json-value
                #:empty-object
                #:object-set
                #:clone-json
                #:ensure-array
                #:ensure-string
                #:ensure-integer
                #:ensure-boolean
                #:quasar-error)
  (:export
   #:workspace
   #:make-workspace
   #:workspace-id
   #:workspace-revision
   #:workspace-documents
   #:workspace-graphs
   #:workspace-settings
   #:workspace-snapshot
   #:workspace-snapshot-page
   #:workspace-graph
   #:copy-workspace
   #:graph-snapshot
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
   #:apply-graph-put
   #:apply-graph-delete
   #:apply-graph-activate
   #:applied-op
   #:applied-op-event
   #:applied-op-result
   #:applied-op-inverse))

(defpackage #:quasar.store
  (:use #:cl)
  (:import-from #:quasar.workspace
                #:workspace
                #:make-workspace
                #:workspace-id
                #:workspace-revision
                #:workspace-snapshot
                #:copy-workspace)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value
                #:clone-json)
  (:export
   #:workspace-store
   #:memory-store
   #:make-memory-store
   #:tek9-store
   #:make-tek9-store
   #:close-store
   #:load-workspace
   #:save-workspace
   #:list-workspaces
   #:append-operation
   #:read-operations
   #:commit-workspace
   #:compact-workspace
   #:store-statistics))

(defpackage #:quasar.control-plane
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:decode-command
                #:encode-event
                #:encode-result
                #:encode-error
                #:quasar-error-to-envelope
                #:quasar-error
                #:json-object
                #:json-array
                #:json-value
                #:empty-object
                #:object-set
                #:clone-json
                #:ensure-array
                #:ensure-string
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
                #:workspace-snapshot-page
                #:workspace-documents
                #:workspace-graphs
                #:workspace-settings
                #:workspace-graph
                #:copy-workspace
                #:graph-snapshot
                #:dispatch-operation
                #:commit-operations
                #:applied-op-event
                #:applied-op-result
                #:applied-op-inverse)
  (:import-from #:quasar.store
                #:make-memory-store
                #:load-workspace
                #:save-workspace
                #:append-operation
                #:commit-workspace)
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
    #:stop-websocket-server
    #:websocket-server-started-p
    #:register-websocket-session
    #:register-autodig-worker-session
    #:register-autodig-client-session
    #:websocket-audit-records
    #:attach-subscriber
    #:detach-subscriber))

(defpackage #:quasar.ui
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:encode
                #:encode-event
                #:encode-error
                #:json-object)
  (:import-from #:quasar.control-plane
                #:submit-command
                #:subscribe)
  (:export
    #:*frontend-url*
    #:*last-session*
    #:frontend-asset-path
    #:start-ui
    #:stop-ui))

(defpackage #:quasar.app
  (:use #:cl)
  (:import-from #:quasar.control-plane
                #:make-control-plane
                #:start-control-plane
                #:stop-control-plane
                #:subscribe
                #:broadcast-event)
  (:import-from #:quasar.store
                #:make-tek9-store
                #:close-store)
  (:import-from #:quasar.starlang
                #:install-starlang-commands)
  (:import-from #:quasar.ws
                #:make-websocket-server
                #:register-websocket-session
                #:start-websocket-server
                #:stop-websocket-server
                #:attach-subscriber)
  (:import-from #:quasar.ui
                #:start-ui
                #:stop-ui)
  (:export
   #:start
   #:stop
   #:main))

(defpackage #:quasar.tests
  (:use #:cl)
  (:export
   #:run-control-plane-tests
   #:run-autodig-control-tests
   #:run-autodig-worker-reclaim-tests
   #:run-autodig-websocket-auth-tests
   #:run-phase2-integration-tests
   #:run-phase2-read-tests
   #:run-phase2-hardening-tests
   #:run-phase2-read-hardening-tests
   #:run-store-tests
   #:run-store-maintenance-tests
   #:run-store-persistence-tests
   #:run-store-recovery-tests
   #:run-websocket-tests
   #:run-starlang-adapter-tests
   #:run-melissa-tests
   #:run-clog-host-tests))
