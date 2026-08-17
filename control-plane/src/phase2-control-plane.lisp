(in-package #:quasar.control-plane)

;; Keep the in-memory store behavior as a compatibility/test fallback while the
;; production Tek9 path becomes durable and bounded. These aliases are captured
;; before the Phase 2 handlers below replace the public command handlers.
(defparameter *phase2-legacy-import-begin* (symbol-function 'handle-import-begin))
(defparameter *phase2-legacy-import-chunk* (symbol-function 'handle-import-chunk))
(defparameter *phase2-legacy-import-abort* (symbol-function 'handle-import-abort))
(defparameter *phase2-legacy-import-commit* (symbol-function 'handle-import-commit))
(defparameter *phase2-legacy-document-list* (symbol-function 'handle-document-list))
(defparameter *phase2-legacy-document-get* (symbol-function 'handle-document-get))
(defparameter *phase2-legacy-snapshot* (symbol-function 'handle-snapshot))
(defparameter *phase2-legacy-graph-snapshot* (symbol-function 'handle-graph-snapshot))

(defun phase2-workspace-id (envelope)
  (or (quasar.protocol:command-envelope-workspace envelope) "default"))

(defun phase2-streaming-p (plane)
  (quasar.store:streaming-store-p (control-plane-store plane)))

(defun phase2-stage-id (payload)
  (quasar.protocol:ensure-string
   (quasar.protocol:json-value payload "sessionId")
   "sessionId"
   "import.invalid-session"))

(defun phase2-sequence (payload)
  (let ((sequence (quasar.protocol:json-value payload "sequence")))
    (unless (and (integerp sequence) (not (minusp sequence)))
      (error 'quasar.protocol:quasar-error
             :code "import.invalid-sequence"
             :message "Import chunk sequence must be a non-negative integer."))
    sequence))

(defun handle-import-begin (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-import-begin* plane payload envelope)
      (let* ((store (control-plane-store plane))
             (workspace-id (phase2-workspace-id envelope))
             (base-revision
               (quasar.store:direct-workspace-revision store workspace-id))
             (stage-id (next-transaction-id))
             (now (get-universal-time)))
        (quasar.store:cleanup-expired-import-stages store now)
        (quasar.store:begin-import-stage
         store workspace-id stage-id base-revision now))))

(defun handle-import-chunk (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-import-chunk* plane payload envelope)
      (let ((store (control-plane-store plane))
            (workspace-id (phase2-workspace-id envelope))
            (stage-id (phase2-stage-id payload))
            (sequence (phase2-sequence payload))
            (operations
              (quasar.protocol:ensure-array
               (quasar.protocol:json-value payload "operations")
               "operations"
               "protocol.invalid-envelope")))
        (quasar.store:accept-import-chunk
         store workspace-id stage-id sequence operations (get-universal-time)))))

(defun handle-import-abort (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-import-abort* plane payload envelope)
      (quasar.store:abort-import-stage
       (control-plane-store plane)
       (phase2-workspace-id envelope)
       (phase2-stage-id payload)
       (get-universal-time))))

(defun handle-import-commit (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-import-commit* plane payload envelope)
      (let* ((store (control-plane-store plane))
             (workspace-id (phase2-workspace-id envelope))
             (stage-id (phase2-stage-id payload))
             (operation-id (next-operation-id))
             (result
               (quasar.store:promote-import-stage
                store
                workspace-id
                stage-id
                operation-id
                (or (quasar.protocol:command-envelope-client envelope) "unknown")
                (get-universal-time)))
             (revision (quasar.protocol:json-value result "revision"))
             (committed-operation-id
               (or (quasar.protocol:json-value result "operationId") operation-id)))
        ;; A successful durable promotion invalidates any compatibility cache.
        ;; The next mutation may restore a workspace, but read-only Phase 2 paths
        ;; do not repopulate it.
        (remhash workspace-id (control-plane-workspaces plane))
        (broadcast-event
         plane "documents.imported" workspace-id revision committed-operation-id result)
        result)))

(defun handle-document-get (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-document-get* plane payload envelope)
      (let* ((workspace-id (phase2-workspace-id envelope))
             (id (quasar.protocol:ensure-string
                  (quasar.protocol:json-value payload "id")
                  "id"
                  "document.invalid"))
             (document
               (quasar.store:direct-document
                (control-plane-store plane) workspace-id id)))
        (unless document
          (error 'quasar.protocol:quasar-error
                 :code "document.not-found"
                 :message (format nil "Document ~A does not exist." id)))
        document)))

(defun handle-document-list (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-document-list* plane payload envelope)
      (apply #'quasar.protocol:json-array
             (quasar.store:direct-document-list
              (control-plane-store plane)
              (phase2-workspace-id envelope)))))

(defun phase2-validate-page-request (payload)
  (let ((offset (quasar.protocol:json-value payload "documentOffset"))
        (requested-limit (quasar.protocol:json-value payload "documentByteLimit")))
    (unless (and (integerp offset) (not (minusp offset)))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "documentOffset must be a non-negative integer."))
    (unless (and (integerp requested-limit) (plusp requested-limit))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "documentByteLimit must be a positive integer."))
    (values offset (min requested-limit (* 512 1024)))))

(defun handle-snapshot (plane payload envelope)
  (if (or (not (phase2-streaming-p plane))
          (and (null (quasar.protocol:json-value payload "documentOffset"))
               (null (quasar.protocol:json-value payload "documentByteLimit"))))
      (funcall *phase2-legacy-snapshot* plane payload envelope)
      (multiple-value-bind (offset byte-limit)
          (phase2-validate-page-request payload)
        (quasar.store:direct-workspace-snapshot-page
         (control-plane-store plane)
         (phase2-workspace-id envelope)
         offset
         byte-limit))))

(defun handle-graph-snapshot (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-graph-snapshot* plane payload envelope)
      (let ((graph-id (or (quasar.protocol:json-value payload "graphId")
                          "all-documents")))
        (quasar.store:direct-graph-snapshot
         (control-plane-store plane)
         (phase2-workspace-id envelope)
         graph-id))))