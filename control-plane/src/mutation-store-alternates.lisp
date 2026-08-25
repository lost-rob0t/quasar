(in-package #:quasar.store)

(defgeneric direct-alternate-graph-metadata
    (store workspace-id excluded-graph-ids)
  (:documentation
   "Return one durable graph metadata record whose id is not excluded."))

(defmethod direct-alternate-graph-metadata
    ((store memory-store) workspace-id excluded-graph-ids)
  (let ((workspace (%memory-workspace-or-default store workspace-id)))
    (loop
      for id being the hash-keys of (quasar.workspace:workspace-graphs workspace)
      using (hash-value graph)
      unless (member id excluded-graph-ids :test #'string=)
        do (return (quasar.protocol:clone-json (%graph-metadata graph))))))

(defmethod direct-alternate-graph-metadata
    ((store tek9-store) workspace-id excluded-graph-ids)
  (let ((database (tek9-store-database store))
        (result nil))
    (block found
      (%map-prefix-bounded
       database
       (%graph-meta-prefix workspace-id)
       (lambda (row)
         (let* ((metadata (cdr row))
                (id (quasar.protocol:json-value metadata "id")))
           (unless (member id excluded-graph-ids :test #'string=)
             (setf result (quasar.protocol:clone-json metadata))
             (return-from found result)))))
      result)))
