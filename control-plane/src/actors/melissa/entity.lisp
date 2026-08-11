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
  (let* ((kind (normalize-entity-kind (json-value object "dtype")))
         (id (json-value object "_id"))
         (dataset (json-value object "dataset" "melissa"))
         (title (json-value object "title" id))
         (data (json-value object "data" (json-object)))
         (extensions (json-value object "extensions" (json-object))))
    (unless (non-empty-string-p id)
      (error "Melissa entity _id must be a non-empty string."))
    (make-canonical-entity
     :kind kind
     :id id
     :dataset dataset
     :title title
     :data data
     :extensions extensions)))

(defun canonical-entity-to-json (entity)
  (json-object
   (cons "_id" (canonical-entity-id entity))
   (cons "dataset" (or (canonical-entity-dataset entity) "melissa"))
   (cons "dtype" (canonical-entity-kind entity))
   (cons "title" (or (canonical-entity-title entity)
                      (canonical-entity-id entity)))
   (cons "data" (or (canonical-entity-data entity) (json-object)))
   (cons "extensions" (or (canonical-entity-extensions entity) (json-object)))))

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
