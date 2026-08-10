(in-package #:quasar.actors.melissa.normalize)

(defun json-children (value)
  (cond
    ((and (consp value) (eq (car value) :obj)) (mapcar #'cdr (cdr value)))
    ((and (consp value) (eq (car value) :array)) (cdr value))
    (t nil)))

(defun find-json-key (value key)
  (cond
    ((and (consp value) (eq (car value) :obj))
     (or (cdr (assoc key (cdr value) :test #'string-equal))
         (loop for child in (json-children value)
               for found = (find-json-key child key)
               when found return found)))
    ((and (consp value) (eq (car value) :array))
     (loop for child in (cdr value)
           for found = (find-json-key child key)
           when found return found))
    (t nil)))

(defun text-value (value)
  (when value
    (let ((text (string-trim '(#\Space #\Tab #\Newline #\Return)
                             (princ-to-string value))))
      (and (plusp (length text)) text))))

(defun find-text (value &rest keys)
  (loop for key in keys
        for result = (text-value (find-json-key value key))
        when result return result))

(defun result-code-error-p (record)
  (let ((results (string-upcase (or (find-text record "Results" "ResultCodes") ""))))
    (loop for index from 0 below (max 0 (- (length results) 3))
          for token = (subseq results index (+ index 4))
          thereis (and (char= (char token 1) #\E)
                       (alpha-char-p (char token 0))
                       (digit-char-p (char token 2))
                       (digit-char-p (char token 3))))))

(defun records-from (raw-result)
  (let ((records (or (find-json-key raw-result "Records")
                     (find-json-key raw-result "records"))))
    (cond
      ((and (consp records) (eq (car records) :array)) (cdr records))
      ((and (consp records) (eq (car records) :obj)) (list records))
      (t nil))))

(defun first-usable-record (raw-result)
  (let ((records (records-from raw-result)))
    (if records
        (find-if-not #'result-code-error-p records)
        raw-result)))

(defun normalized-date (value)
  (let ((text (text-value value)))
    (cond
      ((null text) nil)
      ((and (= (length text) 8) (every #'digit-char-p text))
       (format nil "~A-~A-~AT00:00:00.000Z"
               (subseq text 0 4)
               (subseq text 4 6)
               (subseq text 6 8)))
      ((and (= (length text) 10)
            (char= (char text 4) #\-)
            (char= (char text 7) #\-))
       (concatenate 'string text "T00:00:00.000Z"))
      (t text))))

(defun maybe-put (object key value)
  (if (text-value value)
      (json-object-put object key value)
      object))

(defun enrich-person-data (data record)
  (let* ((full-name (find-text record "NameFull" "FullName" "Name"))
         (first-name (find-text record "NameFirst" "FirstName" "GivenName"))
         (middle-name (find-text record "NameMiddle" "MiddleName"))
         (last-name (find-text record "NameLast" "LastName" "FamilyName" "Surname"))
         (email (find-text record "EmailAddress" "Email" "NewEmail"))
         (phone (find-text record "PhoneNumber" "Phone" "NewPhone" "InternationalPhoneNumber"))
         (dob (normalized-date (find-json-key record "DateOfBirth"))))
    (setf data (maybe-put data "full_name" full-name)
          data (maybe-put data "name" full-name)
          data (maybe-put data "fname" first-name)
          data (maybe-put data "mname" middle-name)
          data (maybe-put data "lname" last-name)
          data (maybe-put data "email" email)
          data (maybe-put data "phone" phone)
          data (maybe-put data "dob" dob))
    data))

(defun enrichment-summary (record provenance)
  (json-object
   (cons "service" (json-value provenance "service" "personator-search"))
   (cons "http_status" (json-value provenance "http_status" 200))
   (cons "results" (or (find-text record "Results" "ResultCodes") ""))
   (cons "melissa_address_key"
         (or (find-text record "MelissaAddressKey" "AddressKey" "MAK") ""))
   (cons "melissa_identity_key"
         (or (find-text record "MelissaIdentityKey" "IdentityKey" "MIK") ""))))

(defun normalize-melissa-result (message)
  (let* ((original (melissa-normalize-original-entity message))
         (raw-result (melissa-normalize-raw-result message))
         (provenance (melissa-normalize-provenance message))
         (record (first-usable-record raw-result))
         (kind (canonical-entity-kind original))
         (data (canonical-entity-data original))
         (extensions (canonical-entity-extensions original)))
    (unless record
      (error "Melissa returned records, but every record contained an error result code."))
    (unless (member kind '("person" "target") :test #'string=)
      (error "Melissa normalization cannot emit entity kind ~S." kind))
    (when (string= kind "person")
      (setf data (enrich-person-data data record)))
    (setf extensions
          (json-object-put
           extensions
           "melissa.api"
           (enrichment-summary record provenance)))
    (make-canonical-entity
     :kind kind
     :id (canonical-entity-id original)
     :dataset (canonical-entity-dataset original)
     :title (or (and (string= kind "person")
                     (find-text record "NameFull" "FullName" "Name"))
                (canonical-entity-title original))
     :data data
     :extensions extensions)))

(defun make-normalizer-actor (actor-system forwarder)
  (sento.actor-context:actor-of
   actor-system
   :name "melissa-normalizer"
   :receive
   (lambda (message)
     (when (typep message 'melissa-normalize)
       (handler-case
           (sento.actor:tell
            forwarder
            (make-melissa-forward
             :request-id (melissa-normalize-request-id message)
             :requestor (melissa-normalize-requestor message)
             :entity (normalize-melissa-result message)))
         (error (condition)
           (sento.actor:tell
            forwarder
            (make-melissa-error
             :request-id (melissa-normalize-request-id message)
             :requestor (melissa-normalize-requestor message)
             :stage :normalize
             :condition (princ-to-string condition)
             :retryable-p nil))))))))
