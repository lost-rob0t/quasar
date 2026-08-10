(in-package #:cl-user)

(export '(quasar.control-plane::register-async-command
          quasar.control-plane::unregister-command
          quasar.control-plane::control-plane-actor-system)
        :quasar.control-plane)

(defpackage #:quasar.actors.melissa
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-array
                #:json-value)
  (:export
   #:+default-melissa-service+
   #:+default-melissa-worker-count+
   #:melissa-config
   #:make-melissa-config
   #:melissa-config-license-key
   #:melissa-config-transmission-reference
   #:melissa-config-default-country
   #:melissa-config-connect-timeout
   #:melissa-config-read-timeout
   #:melissa-config-personator-columns
   #:melissa-config-personator-options
   #:canonical-entity
   #:make-canonical-entity
   #:canonical-entity-kind
   #:canonical-entity-id
   #:canonical-entity-dataset
   #:canonical-entity-title
   #:canonical-entity-data
   #:canonical-entity-extensions
   #:canonical-entity-from-json
   #:canonical-entity-to-json
   #:json-object-put
   #:json-options-to-plist
   #:melissa-request
   #:make-melissa-request
   #:melissa-request-request-id
   #:melissa-request-requestor
   #:melissa-request-entity
   #:melissa-request-options
   #:melissa-lookup
   #:make-melissa-lookup
   #:melissa-lookup-request-id
   #:melissa-lookup-requestor
   #:melissa-lookup-entity
   #:melissa-lookup-options
   #:melissa-lookup-result
   #:make-melissa-lookup-result
   #:melissa-lookup-result-request-id
   #:melissa-lookup-result-requestor
   #:melissa-lookup-result-original-entity
   #:melissa-lookup-result-raw-result
   #:melissa-lookup-result-provenance
   #:melissa-normalize
   #:make-melissa-normalize
   #:melissa-normalize-request-id
   #:melissa-normalize-requestor
   #:melissa-normalize-original-entity
   #:melissa-normalize-raw-result
   #:melissa-normalize-provenance
   #:melissa-forward
   #:make-melissa-forward
   #:melissa-forward-request-id
   #:melissa-forward-requestor
   #:melissa-forward-entity
   #:melissa-completed
   #:make-melissa-completed
   #:melissa-completed-request-id
   #:melissa-completed-entity
   #:melissa-error
   #:make-melissa-error
   #:melissa-error-request-id
   #:melissa-error-requestor
   #:melissa-error-stage
   #:melissa-error-condition
   #:melissa-error-retryable-p
   #:melissa-router-update
   #:make-melissa-router-update
   #:melissa-router-update-router
   #:melissa-http-request
   #:make-melissa-http-request
   #:melissa-http-request-request-id
   #:melissa-http-request-entity
   #:melissa-http-request-options
   #:melissa-http-request-on-success
   #:melissa-http-request-on-error
   #:melissa-subsystem
   #:melissa-subsystem-actor-system
   #:melissa-subsystem-config
   #:melissa-subsystem-transport
   #:melissa-subsystem-worker-count
   #:melissa-subsystem-supervisor
   #:melissa-subsystem-request-router
   #:melissa-subsystem-worker-router
   #:melissa-subsystem-workers
   #:melissa-subsystem-normalizer
   #:melissa-subsystem-forwarder
   #:melissa-subsystem-http-bridge
   #:melissa-subsystem-stopped-p))

(defpackage #:quasar.actors.melissa.transport
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:json-object
                #:json-value)
  (:import-from #:quasar.actors.melissa
                #:canonical-entity
                #:canonical-entity-kind
                #:canonical-entity-title
                #:canonical-entity-data
                #:melissa-config
                #:melissa-config-license-key
                #:melissa-config-transmission-reference
                #:melissa-config-default-country
                #:melissa-config-connect-timeout
                #:melissa-config-read-timeout
                #:melissa-config-personator-columns
                #:melissa-config-personator-options)
  (:export
   #:perform-melissa-lookup
   #:retryable-transport-condition-p))

(defpackage #:quasar.actors.melissa.normalize
  (:use #:cl)
  (:import-from #:quasar.protocol #:json-object #:json-value)
  (:import-from #:quasar.actors.melissa
                #:canonical-entity
                #:make-canonical-entity
                #:canonical-entity-kind
                #:canonical-entity-id
                #:canonical-entity-dataset
                #:canonical-entity-title
                #:canonical-entity-data
                #:canonical-entity-extensions
                #:json-object-put
                #:melissa-normalize
                #:melissa-normalize-request-id
                #:melissa-normalize-requestor
                #:melissa-normalize-original-entity
                #:melissa-normalize-raw-result
                #:melissa-normalize-provenance
                #:make-melissa-forward
                #:make-melissa-error)
  (:export #:normalize-melissa-result #:make-normalizer-actor))

(defpackage #:quasar.actors.melissa.forwarder
  (:use #:cl)
  (:import-from #:quasar.actors.melissa
                #:melissa-forward
                #:melissa-forward-request-id
                #:melissa-forward-requestor
                #:melissa-forward-entity
                #:make-melissa-completed
                #:melissa-error
                #:melissa-error-requestor)
  (:export #:make-forwarder-actor))

(defpackage #:quasar.actors.melissa.lookup
  (:use #:cl)
  (:import-from #:quasar.actors.melissa
                #:melissa-lookup
                #:melissa-lookup-request-id
                #:melissa-lookup-requestor
                #:melissa-lookup-entity
                #:melissa-lookup-options
                #:make-melissa-normalize
                #:make-melissa-error)
  (:import-from #:quasar.actors.melissa.transport
                #:retryable-transport-condition-p)
  (:export #:make-lookup-worker))

(defpackage #:quasar.actors.melissa.router
  (:use #:cl)
  (:import-from #:quasar.actors.melissa
                #:canonical-entity
                #:canonical-entity-kind
                #:melissa-request
                #:melissa-request-request-id
                #:melissa-request-requestor
                #:melissa-request-entity
                #:melissa-request-options
                #:make-melissa-lookup
                #:make-melissa-error
                #:melissa-router-update
                #:melissa-router-update-router)
  (:export #:make-request-router))

(defpackage #:quasar.actors.melissa.supervisor
  (:use #:cl)
  (:import-from #:quasar.protocol #:json-object #:json-array)
  (:import-from #:quasar.actors.melissa
                #:+default-melissa-worker-count+
                #:make-melissa-config
                #:melissa-config-license-key
                #:melissa-subsystem
                #:melissa-subsystem-actor-system
                #:melissa-subsystem-config
                #:melissa-subsystem-transport
                #:melissa-subsystem-worker-count
                #:melissa-subsystem-supervisor
                #:melissa-subsystem-request-router
                #:melissa-subsystem-worker-router
                #:melissa-subsystem-workers
                #:melissa-subsystem-normalizer
                #:melissa-subsystem-forwarder
                #:melissa-subsystem-http-bridge
                #:melissa-subsystem-stopped-p
                #:make-melissa-router-update)
  (:import-from #:quasar.actors.melissa.transport #:perform-melissa-lookup)
  (:import-from #:quasar.actors.melissa.lookup #:make-lookup-worker)
  (:import-from #:quasar.actors.melissa.normalize #:make-normalizer-actor)
  (:import-from #:quasar.actors.melissa.forwarder #:make-forwarder-actor)
  (:import-from #:quasar.actors.melissa.router #:make-request-router)
  (:export #:start-melissa-subsystem #:stop-melissa-subsystem #:melissa-subsystem-status))

(defpackage #:quasar.actors.melissa.bridge
  (:use #:cl)
  (:import-from #:quasar.protocol
                #:encode-result
                #:encode-error
                #:json-object
                #:json-value)
  (:import-from #:quasar.control-plane
                #:register-command
                #:register-async-command
                #:unregister-command
                #:control-plane-actor-system)
  (:import-from #:quasar.actors.melissa
                #:+default-melissa-worker-count+
                #:make-melissa-config
                #:canonical-entity-from-json
                #:canonical-entity-to-json
                #:json-options-to-plist
                #:melissa-subsystem-http-bridge
                #:melissa-completed
                #:melissa-completed-request-id
                #:melissa-completed-entity
                #:melissa-error
                #:melissa-error-request-id
                #:melissa-error-stage
                #:melissa-error-condition
                #:melissa-error-retryable-p
                #:make-melissa-request
                #:melissa-http-request
                #:make-melissa-http-request
                #:melissa-http-request-request-id
                #:melissa-http-request-entity
                #:melissa-http-request-options
                #:melissa-http-request-on-success
                #:melissa-http-request-on-error)
  (:import-from #:quasar.actors.melissa.supervisor
                #:start-melissa-subsystem
                #:stop-melissa-subsystem
                #:melissa-subsystem-status)
  (:export
   #:make-http-bridge-actor
   #:start-melissa-integration
   #:stop-melissa-integration
   #:melissa-subsystem-for))
