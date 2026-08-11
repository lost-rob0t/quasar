(in-package #:quasar.actors.melissa)

(defparameter +default-melissa-service+ "personator-search")
(defparameter +default-melissa-worker-count+ 3)

(defstruct melissa-config
  license-key
  (transmission-reference "Quasar")
  (default-country "US")
  (connect-timeout 10)
  (read-timeout 25)
  (personator-columns
   "PreviousAddress,DateOfBirth,DateOfDeath,Email,MelissaIdentityKey,MoveDate,Phone,Suffix")
  (personator-options
   "SearchType:Auto,SearchConditions:progressive,RecordsPerPage:10,MaxEmail:10,MaxPhone:10"))

(defstruct canonical-entity
  kind
  id
  dataset
  title
  data
  extensions)

(defstruct melissa-request
  request-id
  requestor
  entity
  options)

(defstruct melissa-lookup
  request-id
  requestor
  entity
  options)

(defstruct melissa-lookup-result
  request-id
  requestor
  original-entity
  raw-result
  provenance)

(defstruct melissa-normalize
  request-id
  requestor
  original-entity
  raw-result
  provenance)

(defstruct melissa-forward
  request-id
  requestor
  entity)

(defstruct melissa-completed
  request-id
  entity)

(defstruct melissa-error
  request-id
  requestor
  stage
  condition
  retryable-p)

(defstruct melissa-router-update
  router)

(defstruct melissa-http-request
  request-id
  entity
  options
  on-success
  on-error)

(defclass melissa-subsystem ()
  ((actor-system
    :initarg :actor-system
    :reader melissa-subsystem-actor-system)
   (config
    :initarg :config
    :reader melissa-subsystem-config)
   (transport
    :initarg :transport
    :reader melissa-subsystem-transport)
   (worker-count
    :initarg :worker-count
    :reader melissa-subsystem-worker-count)
   (supervisor
    :initform nil
    :accessor melissa-subsystem-supervisor)
   (request-router
    :initform nil
    :accessor melissa-subsystem-request-router)
   (worker-router
    :initform nil
    :accessor melissa-subsystem-worker-router)
   (workers
    :initform nil
    :accessor melissa-subsystem-workers)
   (normalizer
    :initform nil
    :accessor melissa-subsystem-normalizer)
   (forwarder
    :initform nil
    :accessor melissa-subsystem-forwarder)
   (http-bridge
    :initform nil
    :accessor melissa-subsystem-http-bridge)
   (stopped-p
    :initform nil
    :accessor melissa-subsystem-stopped-p)))
