(in-package #:quasar.workspace)

(defclass workspace ()
  ((id :initarg :id :reader workspace-id)
   (revision :initform 0 :accessor workspace-revision)
   (documents :initform (make-hash-table :test #'equal)
              :reader workspace-documents)
   (graphs :initform (make-hash-table :test #'equal)
           :reader workspace-graphs)
   (settings :initform (make-hash-table :test #'equal)
             :reader workspace-settings)
   (journal :initform '() :accessor workspace-journal)))

(defun make-workspace (&key (id "default"))
  (make-instance 'workspace :id id))

(defun hash-table-values (table)
  (loop for value being the hash-values of table collect value))

(defun hash-table-object (table)
  (apply #'json-object
         (loop for key being the hash-keys of table
               using (hash-value value)
               collect (cons key value))))

(defun workspace-snapshot (workspace)
  (json-object
   (cons "id" (workspace-id workspace))
   (cons "revision" (workspace-revision workspace))
   (cons "documents"
         (apply #'json-array (hash-table-values (workspace-documents workspace))))
   (cons "graphs"
         (apply #'json-array (hash-table-values (workspace-graphs workspace))))
   (cons "settings" (hash-table-object (workspace-settings workspace)))))

(defun require-object-id (object field)
  (let ((id (json-value object field)))
    (unless (and (stringp id) (plusp (length id)))
      (error "~A must be a non-empty string." field))
    id))

(defun save-document (workspace document)
  (let ((id (require-object-id document "_id")))
    (setf (gethash id (workspace-documents workspace)) document)
    (json-object (cons "saved" id))))

(defun remove-document (workspace payload)
  (let ((id (require-object-id payload "id")))
    (remhash id (workspace-documents workspace))
    (json-object (cons "removed" id))))

(defun save-graph (workspace graph)
  (let ((id (require-object-id graph "id")))
    (setf (gethash id (workspace-graphs workspace)) graph)
    (json-object (cons "savedGraph" id))))

(defun patch-settings (workspace patch)
  (unless (and (consp patch) (eq (first patch) :obj))
    (error "settings.patch expects a JSON object."))
  (dolist (entry (rest patch))
    (setf (gethash (car entry) (workspace-settings workspace)) (cdr entry)))
  (json-object (cons "settingsPatched" t)))

(defun operation-type (operation)
  (json-value operation "type"))

(defun apply-workspace-operation (workspace operation)
  (let* ((type (operation-type operation))
         (payload (json-value operation "payload" (json-object)))
         (result
           (cond
             ((string= type "document.save")
              (save-document workspace payload))
             ((string= type "document.remove")
              (remove-document workspace payload))
             ((string= type "graph.save")
              (save-graph workspace payload))
             ((string= type "settings.patch")
              (patch-settings workspace payload))
             (t
              (error "Unsupported workspace operation ~S." type)))))
    (incf (workspace-revision workspace))
    (push operation (workspace-journal workspace))
    (json-object
     (cons "revision" (workspace-revision workspace))
     (cons "result" result)
     (cons "snapshot" (workspace-snapshot workspace)))))
