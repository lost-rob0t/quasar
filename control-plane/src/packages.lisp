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
    #:ensure-object-id
    #:clone-json))

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
    #:tek9-store
    #:make-tek9-store
    #:default-tek9-path
    #:tek9-store-path
    #:tek9-store-failure-hook
    #:tek9-store-last-commit-stats
    #:unsupported-storage-schema
    #:load-workspace
    #:save-workspace
    #:append-operation
    #:commit-workspace
    #:store-journal-entries
    #:close-store
    #:streaming-store-p
    #:direct-document
    #:direct-document-list
    #:direct-workspace-snapshot-page
    #:direct-workspace-revision
    #:direct-graph-snapshot
    #:begin-import-stage
    #:accept-import-chunk
    #:promote-import-stage
    #:abort-import-stage
    #:cleanup-expired-import-stages))

(defpackage #:quasar.workspace
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value
                #:empty-object
                #:ensure-string
                #:ensure-object
                #:ensure-array
                #:clone-json
                #:object-set
                #:quasar-error)
  (:export
    #:workspace
    #:persistent-workspace
    #:make-workspace
    #:workspace-id
    #:workspace-revision
    #:workspace-documents
    #:workspace-graphs
    #:workspace-settings
    #:workspace-journal
    #:copy-workspace
    #:workspace-persistence-changes
    #:clear-workspace-persistence-changes
    #:persistence-change
    #:make-persistence-change
    #:persistence-change-kind
    #:persistence-change-graph-id
    #:persistence-change-id
    #:persistence-change-value
    #:workspace-graph
    #:workspace-snapshot
    #:workspace-snapshot-page
    #:graph-snapshot
    #:graph-node
    #:graph-edge
    #:graph-nodes
    #:graph-edges
    #:array-elements
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