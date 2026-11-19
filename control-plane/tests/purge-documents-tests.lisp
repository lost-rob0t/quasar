(in-package #:quasar.tests)

;;; Meta documentCount must equal the real number of rows under the
;;; workspace document prefix. Divergence silently breaks bounded pagination
;;; and operator trust: the live store once reported 406 while holding 45349
;;; rows. These tests pin the invariant across the purge path, including the
;;; legacy case where the meta record undercounts and the purge must report
;;; and remove the REAL row population.

(defun purge-test-document (index)
  (quasar.protocol:json-object
   (cons "id" (format nil "purge:~6,'0D" index))
   (cons "dtype" "person")
   (cons "dataset" "alpha")
   (cons "schemaVersion" "0.10.1")
   (cons "updatedAt" index)
   (cons "extensions" (quasar.protocol:json-object))))

(defun %purge-meta-count (database workspace-id)
  (quasar.protocol:json-value
   (tek9:fetch* database (quasar.store::%workspace-meta-key workspace-id))
   "documentCount"
   :missing))

(defun %purge-prefix-count (database workspace-id)
  (quasar.store::%count-prefix-bounded
   database (quasar.store::%document-prefix workspace-id)))

(defun %purge-scratch-store ()
  (quasar.store:make-tek9-store
   :path (merge-pathnames
          (format nil "quasar-purge-test-~36R/" (get-universal-time))
          (uiop:temporary-directory))))

(defun %purge-seed (database workspace-id count meta-count)
  (tek9:with-write-transaction (database)
    (tek9:put-bulk
     database
     (loop for index from 0 below count
           for document = (purge-test-document index)
           collect (tek9:new-document
                    :id (quasar.store::%document-key
                         workspace-id
                         (quasar.protocol:json-value document "id"))
                    :value document)))
    (quasar.store::%put-record
     database
     (quasar.store::%workspace-meta-key workspace-id)
     (quasar.store::%default-workspace-meta workspace-id 7 meta-count))))

(defun run-purge-documents-tests ()
  (let ((failures-before *failures*))
    (format t "~&Running purge documents tests...~%")
    ;; Consistent meta and prefix: purge reports every row, empties the
    ;; prefix, and drives the durable count to zero.
    (let ((store (%purge-scratch-store))
          (workspace-id "purge-test"))
      (unwind-protect
           (let ((database (quasar.store::tek9-store-database store)))
             (%purge-seed database workspace-id 40 40)
             (check (= 40 (%purge-prefix-count database workspace-id)))
             (check (= 40 (%purge-meta-count database workspace-id)))
             (let ((deleted (quasar.store:purge-workspace-documents store workspace-id)))
               (check (= deleted 40))
               (check (= 0 (%purge-prefix-count database workspace-id)))
               (check (= 0 (%purge-meta-count database workspace-id)))))
        (quasar.store:close-store store)))
    ;; Legacy undercount: 60 rows exist but meta claims 6. The purge must
    ;; report and remove the REAL row population, never the stale number.
    (let ((store (%purge-scratch-store))
          (workspace-id "purge-legacy"))
      (unwind-protect
           (let ((database (quasar.store::tek9-store-database store)))
             (%purge-seed database workspace-id 60 6)
             (let ((deleted (quasar.store:purge-workspace-documents store workspace-id)))
               (check (= deleted 60))
               (check (= 0 (%purge-prefix-count database workspace-id)))))
        (quasar.store:close-store store)))
    (check (= *failures* failures-before))))
