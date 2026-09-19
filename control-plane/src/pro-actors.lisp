(in-package #:quasar.control-plane)

(defparameter +pro-actor-manifest-extension+ "starintel.actor_manifest.v1")
(defparameter +pro-actor-repository+ "lost-rob0t/starintel-pro-actors")

(defun pro-actor-contract (document)
  "Return DOCUMENT's trusted pro-actor manifest contract, or NIL."
  (when (and document
             (string= (or (quasar.protocol:json-value document "dtype") "")
                      "actor-manifest"))
    (let* ((extensions (quasar.protocol:json-value document "extensions"))
           (contract (and extensions
                          (quasar.protocol:json-value
                           extensions +pro-actor-manifest-extension+)))
           (implementation (and contract
                                (quasar.protocol:json-value contract "implementation")))
           (repository (and implementation
                            (quasar.protocol:json-value implementation "repository"))))
      (and (stringp repository)
           (string= repository +pro-actor-repository+)
           contract))))

(defun pro-actor-manifests (plane envelope)
  "Return pro-actor manifests visible in ENVELOPE's current workspace."
  (let* ((workspace (workspace-for plane envelope))
         (documents (workspace-documents workspace)))
    (sort
     (loop for document being the hash-values of documents
           when (pro-actor-contract document)
             collect (quasar.protocol:clone-json document))
     #'string<
     :key (lambda (document)
            (or (quasar.protocol:json-value
                 (pro-actor-contract document) "actor_id")
                "")))))

(defun find-pro-actor-manifest (plane envelope actor)
  (find actor
        (pro-actor-manifests plane envelope)
        :test #'string=
        :key (lambda (document)
               (quasar.protocol:json-value
                (pro-actor-contract document) "actor_id" ""))))

(defun pro-actor-error (code message)
  (error 'quasar.protocol:quasar-error
         :code code
         :message message
         :details (quasar.protocol:empty-object)))

(defun validate-pro-actor-target (plane payload envelope)
  "Authorize one canonical target against a discovered pro-actor manifest.

WebSocket session capabilities are checked before this handler is reached.
This second gate validates that the requested actor is actually advertised by
a canonical starintel-pro-actors manifest visible in the caller's workspace.
It deliberately performs no network effect; the browser submits the validated
canonical target through the configured StarIntel server contract afterwards."
  (let ((target (quasar.protocol:json-value payload "target")))
    (unless target
      (pro-actor-error "pro-actors.invalid-target" "A target document is required."))
    (unless (string= (or (quasar.protocol:json-value target "dtype") "") "target")
      (pro-actor-error "pro-actors.invalid-target" "The document must have dtype target."))
    (let* ((data (quasar.protocol:json-value target "data"))
           (actor (and data (quasar.protocol:json-value data "actor")))
           (target-value (and data (quasar.protocol:json-value data "target")))
           (target-id (quasar.protocol:json-value target "_id")))
      (unless (and (stringp actor) (plusp (length actor)))
        (pro-actor-error "pro-actors.invalid-target" "Target data.actor is required."))
      (unless (and (stringp target-value) (plusp (length target-value)))
        (pro-actor-error "pro-actors.invalid-target" "Target data.target is required."))
      (unless (and (stringp target-id) (plusp (length target-id)))
        (pro-actor-error "pro-actors.invalid-target" "Target _id is required."))
      (let ((manifest (find-pro-actor-manifest plane envelope actor)))
        (unless manifest
          (pro-actor-error
           "pro-actors.manifest-missing"
           (format nil "No canonical pro-actor manifest is available for ~A." actor)))
        (quasar.protocol:json-object
         (cons "authorized" t)
         (cons "actor" actor)
         (cons "targetId" target-id)
         (cons "manifestId" (quasar.protocol:json-value manifest "_id")))))))

(defun install-pro-actor-commands (plane)
  "Register paid pro-actor discovery and target authorization commands.

Registration does not grant access. quasar.ws still requires the current
session to carry these exact command names as capabilities, which hosted
StarIntel derives from the paid Pro-plan entitlement in starintel-biz."
  (register-command
   plane "pro-actors.manifests"
   (lambda (payload envelope)
     (declare (ignore payload))
     (apply #'quasar.protocol:json-array
            (pro-actor-manifests plane envelope))))
  (register-command
   plane "pro-actors.submit-target"
   (lambda (payload envelope)
     (validate-pro-actor-target plane payload envelope)))
  plane)
