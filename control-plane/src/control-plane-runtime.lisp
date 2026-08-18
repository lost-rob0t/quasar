(in-package #:quasar.control-plane)

(defun handle-snapshot (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (offset (quasar.protocol:json-value payload "documentOffset"))
         (requested-limit
           (quasar.protocol:json-value payload "documentByteLimit")))
    (if (or offset requested-limit)
        (progn
          (unless (and (integerp offset) (not (minusp offset)))
            (error 'quasar.protocol:quasar-error
                   :code "protocol.invalid-envelope"
                   :message
                   "documentOffset must be a non-negative integer."))
          (unless (and (integerp requested-limit) (plusp requested-limit))
            (error 'quasar.protocol:quasar-error
                   :code "protocol.invalid-envelope"
                   :message
                   "documentByteLimit must be a positive integer."))
          (quasar.workspace:workspace-snapshot-page
           workspace offset (min requested-limit (* 512 1024))))
        (quasar.workspace:workspace-snapshot workspace))))

(defun handle-graph-snapshot (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (graph-id
           (or (quasar.protocol:json-value payload "graphId") "default")))
    (quasar.workspace:graph-snapshot workspace graph-id)))

(defun install-core-commands (plane)
  (register-command
   plane "system.capabilities"
   (lambda (payload envelope)
     (declare (ignore payload envelope))
     (apply #'quasar.protocol:json-array (control-plane-capabilities plane))))
  (register-command
   plane "workspace.snapshot"
   (lambda (payload envelope)
     (handle-snapshot plane payload envelope)))
  (register-command
   plane "workspace.transaction"
   (lambda (payload envelope)
     (handle-transaction plane payload envelope)))
  (register-command
   plane "document.import.begin"
   (lambda (payload envelope)
     (handle-import-begin plane payload envelope)))
  (register-command
   plane "document.import.chunk"
   (lambda (payload envelope)
     (handle-import-chunk plane payload envelope)))
  (register-command
   plane "document.import.commit"
   (lambda (payload envelope)
     (handle-import-commit plane payload envelope)))
  (register-command
   plane "document.import.abort"
   (lambda (payload envelope)
     (handle-import-abort plane payload envelope)))
  (register-command
   plane "document.list"
   (lambda (payload envelope)
     (handle-document-list plane payload envelope)))
  (register-command
   plane "document.get"
   (lambda (payload envelope)
     (handle-document-get plane payload envelope)))
  (register-command
   plane "document.create"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "document.create")))
  (register-command
   plane "document.update"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "document.update")))
  (register-command
   plane "document.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "document.delete")))
  (register-command
   plane "graph.snapshot"
   (lambda (payload envelope)
     (handle-graph-snapshot plane payload envelope)))
  (register-command
   plane "graph.workspace.put"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.put")))
  (register-command
   plane "graph.workspace.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.delete")))
  (register-command
   plane "graph.workspace.activate"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.activate")))
  (register-command
   plane "graph.node.create"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.node.create")))
  (register-command
   plane "graph.node.update"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.node.update")))
  (register-command
   plane "graph.node.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.node.delete")))
  (register-command
   plane "graph.edge.create"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.edge.create")))
  (register-command
   plane "graph.edge.update"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.edge.update")))
  (register-command
   plane "graph.edge.delete"
   (lambda (payload envelope)
     (handle-operation plane payload envelope "graph.edge.delete")))
  plane)

(defun dispatch-message (plane message)
  (destructuring-bind (&key envelope reply) message
    (let* ((id (quasar.protocol:command-envelope-id envelope))
           (command (quasar.protocol:command-envelope-command envelope))
           (payload (quasar.protocol:command-envelope-payload envelope))
           (handler (gethash command (control-plane-handlers plane))))
      (handler-case
          (if handler
              (funcall
               reply
               (quasar.protocol:encode-result
                id (funcall handler payload envelope)))
              (funcall
               reply
               (quasar.protocol:encode-error
                id
                "protocol.unknown-command"
                (format nil "Unknown command ~A." command)
                (quasar.protocol:empty-object))))
        (quasar.protocol:quasar-error (condition)
          (funcall
           reply
           (quasar.protocol:quasar-error-to-envelope id condition)))
        (error (condition)
          (format *error-output*
                  "~&[control-plane] unexpected error: ~A~%"
                  condition)
          (funcall
           reply
           (quasar.protocol:encode-error
            id
            "control-plane.unavailable"
            "The control plane could not process the command."
            (quasar.protocol:empty-object))))))))

(defun start-control-plane (plane)
  (unless (control-plane-started-p plane)
    (install-core-commands plane)
    (setf
     (control-plane-actor-system plane)
     (sento.actor-system:make-actor-system))
    (setf
     (control-plane-command-actor plane)
     (sento.actor-context:actor-of
      (control-plane-actor-system plane)
      :name "quasar-control-plane"
      :receive
      (lambda (message)
        (dispatch-message plane message))))
    (setf (control-plane-started-p plane) t))
  plane)

(defun maybe-shutdown-actor-system (system)
  (let ((symbol (find-symbol "SHUTDOWN" "SENTO.ACTOR-SYSTEM")))
    (when (and symbol (fboundp symbol))
      (funcall symbol system))))

(defun stop-control-plane (plane)
  (when (control-plane-started-p plane)
    (maybe-shutdown-actor-system (control-plane-actor-system plane))
    (setf (control-plane-command-actor plane) nil
          (control-plane-actor-system plane) nil
          (control-plane-started-p plane) nil))
  t)

(defun submit-command (plane encoded reply)
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (let ((envelope (quasar.protocol:decode-command encoded)))
    (sento.actor:tell
     (control-plane-command-actor plane)
     (list :envelope envelope :reply reply))
    (quasar.protocol:command-envelope-id envelope)))

(defun submit-decoded (plane envelope reply)
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (sento.actor:tell
   (control-plane-command-actor plane)
   (list :envelope envelope :reply reply))
  (quasar.protocol:command-envelope-id envelope))
