(in-package #:quasar.control-plane)

(defun bounded-wire-result (result envelope byte-limit)
  (let ((bytes (+ (quasar.store::%utf8-length (quasar.protocol:encode result))
                  (- (quasar.store::%utf8-length
                      (quasar.protocol:encode-result
                       (quasar.protocol:command-envelope-id envelope) (quasar.protocol:empty-object)))
                     2))))
    (when (> bytes byte-limit)
      (error 'quasar.protocol:quasar-error :code "query.record-too-large"
             :message "The response envelope exceeds the byte budget."))
    result))

(defun install-bounded-read-commands (plane)
  (register-command plane "workspace.bootstrap"
                    (lambda (payload envelope)
                      (declare (ignore payload))
                      (bounded-wire-result
                       (quasar.store:workspace-bootstrap
                        (control-plane-store plane) (phase2-workspace-id envelope))
                       envelope quasar.store::*query-max-bytes*)))
  (register-command plane "document.search"
                    (lambda (payload envelope)
                      (bounded-wire-result
                       (quasar.store:search-documents
                        (control-plane-store plane) (phase2-workspace-id envelope) payload)
                       envelope (quasar.protocol:json-value payload "byteLimit" quasar.store::*query-max-bytes*))))
  (register-command plane "document.batch"
                    (lambda (payload envelope)
                      (bounded-wire-result
                       (quasar.store:fetch-document-batch
                        (control-plane-store plane) (phase2-workspace-id envelope) payload)
                       envelope (quasar.protocol:json-value payload "byteLimit" quasar.store::*query-max-bytes*))))
  plane)
