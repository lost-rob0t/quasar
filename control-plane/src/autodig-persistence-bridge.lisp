(in-package #:quasar.control-plane)

(defun autodig-journal-entries (plane workspace-id)
  (or (quasar.autodig.store:run-events
       (control-plane-autodig-store plane)
       workspace-id)
      nil))

(defun autodig-persist-run (plane workspace-id command run)
  (let* ((revision (autodig-next-revision plane workspace-id))
         (operation-id (next-operation-id))
         (event
           (quasar.protocol:json-object
            (cons "operationId" operation-id)
            (cons "committedRevision" revision)
            (cons "workspaceId" workspace-id)
            (cons "command" command)
            (cons "timestamp" (get-universal-time))
            (cons "run" (quasar.protocol:clone-json run)))))
    (quasar.autodig.store:append-run-event
     (control-plane-autodig-store plane)
     workspace-id
     event)
    (quasar.protocol:clone-json run)))
