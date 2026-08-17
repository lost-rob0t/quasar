(in-package #:quasar.control-plane)

(defun phase2-page-request (payload)
  (let ((offset
          (or (quasar.protocol:json-value payload "documentOffset" nil)
              0))
        (byte-limit
          (or (quasar.protocol:json-value payload "documentByteLimit" nil)
              (* 512 1024))))
    (unless (and (integerp offset) (not (minusp offset)))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "documentOffset must be a non-negative integer."))
    (unless (and (integerp byte-limit) (plusp byte-limit))
      (error 'quasar.protocol:quasar-error
             :code "protocol.invalid-envelope"
             :message "documentByteLimit must be a positive integer."))
    (values offset (min byte-limit (* 512 1024)))))

(defun handle-snapshot (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-snapshot* plane payload envelope)
      (multiple-value-bind (offset byte-limit)
          (phase2-page-request payload)
        (quasar.store:direct-workspace-snapshot-page
         (control-plane-store plane)
         (phase2-workspace-id envelope)
         offset
         byte-limit))))

(defun handle-document-list (plane payload envelope)
  (if (not (phase2-streaming-p plane))
      (funcall *phase2-legacy-document-list* plane payload envelope)
      (multiple-value-bind (offset byte-limit)
          (phase2-page-request payload)
        (let* ((snapshot
                 (quasar.store:direct-workspace-snapshot-page
                  (control-plane-store plane)
                  (phase2-workspace-id envelope)
                  offset
                  byte-limit))
               (documents
                 (quasar.protocol:json-value snapshot "documents"))
               (page
                 (quasar.protocol:json-value snapshot "documentPage"))
               (revision
                 (quasar.protocol:json-value snapshot "revision" 0)))
          (quasar.protocol:json-object
           (cons "documents" documents)
           (cons "documentPage" page)
           (cons "revision" revision))))))