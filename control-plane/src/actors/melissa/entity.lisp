(in-package #:quasar.actors.melissa)

(defun non-empty-string-p (value)
  (and (stringp value)
       (plusp (length (string-trim '(#\Space #\Tab #\Newline #\Return) value)))))

(defun normalize-entity-kind (value)
  (let ((kind (string-downcase (or value ""))))
    (unless (member kind '("person" "target") :test #'string=)
      (error "Melissa accepts canonical person or target entities, got ~S." value))
    kind))

(defun canonical-entity-from-json (object)
  (quasar.protocol:require-canonical-document object)
  (let* ((kind (normalize-entity-kind (json-value object "dtype")))
         (id (json-value object "id")))
    (make-canonical-entity
     :kind kind :id id :dataset (json-value object "dataset")
     :title (json-value object "displayName" id)
     :data (quasar.protocol:clone-json object)
     :extensions (json-value object "extensions" (json-object)))))

(defun canonical-entity-to-json (entity)
  (let ((document (quasar.protocol:clone-json (canonical-entity-data entity))))
    (setf document (json-object-put document "id" (canonical-entity-id entity))
          document (json-object-put document "dtype" (canonical-entity-kind entity))
          document (json-object-put document "dataset" (canonical-entity-dataset entity))
          document (json-object-put document "schemaVersion" "0.10.1")
          document (json-object-put document "extensions"
                     (or (canonical-entity-extensions entity) (json-object))))
    (quasar.protocol:require-canonical-document document)))

(defun json-object-pairs (object)
  (if (and (consp object) (eq (car object) :obj))
      (cdr object)
      nil))

(defun json-object-put (object key value)
  (let ((pairs (remove key
                       (json-object-pairs object)
                       :key #'car
                       :test #'string=)))
    (cons :obj (cons (cons key value) pairs))))

(defun json-option-value (object key)
  (let ((value (json-value object key nil)))
    (unless (or (null value) (eq value :null))
      value)))

(defun json-options-to-plist (object)
  (when object
    (loop for (key keyword) in '(("service" :service)
                                 ("action" :action)
                                 ("options" :options)
                                 ("columns" :columns)
                                 ("max_records" :max-records)
                                 ("match_level" :match-level)
                                 ("reverse_distance" :reverse-distance)
                                 ("reverse_records" :reverse-records))
          for value = (json-option-value object key)
          when value
            append (list keyword value))))
