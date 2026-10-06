(in-package #:quasar.protocol)

(defun starintel-document-id (document)
  "Read canonical IDs, or explicitly preserve historical IDs during storage reads."
  (if (json-value document "schemaVersion")
      (json-value document "id")
      (json-value document "_id")))

(defun require-canonical-document (document)
  "All new writes and actor outputs must satisfy the immutable generated contract."
  (ensure-object document "document" "document.invalid")
  (handler-case
      (starintel.canonical:validate-document
       (com.inuoe.jzon:parse (encode document)))
    (error (condition)
      (error 'quasar-error :code "document.invalid"
             :message (format nil "Invalid canonical StarIntel document: ~A" condition))))
  document)
