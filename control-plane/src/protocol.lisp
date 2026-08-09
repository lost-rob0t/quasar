(in-package #:quasar.protocol)

(defparameter +protocol-version+ "quasar.control.v1")

(defun empty-object () (cons :obj nil))
(defun empty-array () (cons :array nil))

(defun json-object (&rest pairs) (cons :obj pairs))
(defun json-array (&rest values) (cons :array values))

(defun json-value (object key &optional default)
  (handler-case
      (jsown:val object key)
    (error () default)))

(defun json-get (object key)
  (jsown:val object key))

(defun object-p (value)
  (and (consp value) (eq (car value) :obj)))

(defun array-p (value)
  "Return T if VALUE is a JSON array.
Handles two representations:
  - Our convention: (:array . elements)
  - JSOWN native (from jsown:parse): a plain list of elements where the
    first element is neither the :OBJ keyword (object) nor a string
    (key-value pair)."
  (or (null value)
      (and (consp value)
           (not (eq (car value) :obj))
           (not (stringp (car value))))))

(defun object-keys (object)
  (mapcar #'car (rest object)))

(defun object-set (object key value)
  (setf (jsown:val object key) value)
  object)

(defun clone-json (value)
  "Deep-clone a JSOWN value (object, array, or scalar).
  Objects (:obj . pairs) and arrays (:array . elements) are recursively
  copied; scalars (strings, numbers, T, NIL) are returned as-is because
  they are immutable in Common Lisp."
  (cond
    ((object-p value)
     (cons :obj
           (loop for (key . val) in (rest value)
                 collect (cons key (clone-json val)))))
    ((and (consp value) (eq (car value) :array))
     (cons :array
           (mapcar #'clone-json (rest value))))
    ((array-p value)
     (mapcar #'clone-json value))
    (t value)))

(define-condition quasar-error (error)
  ((code :initarg :code :reader quasar-error-code)
   (message :initarg :message :reader quasar-error-message)
   (details :initarg :details :initform nil :reader quasar-error-details))
  (:report (lambda (condition stream)
             (format stream "~A: ~A"
                     (quasar-error-code condition)
                     (quasar-error-message condition)))))

(defun make-quasar-error (code message &optional details)
  (make-instance 'quasar-error
                 :code code
                 :message message
                 :details (or details (empty-object))))

(defparameter +error-codes+
  '("protocol.invalid-envelope"
    "protocol.unknown-command"
    "workspace.not-found"
    "workspace.revision-conflict"
    "document.not-found"
    "document.invalid"
    "document.duplicate-id"
    "graph.node-not-found"
    "graph.edge-not-found"
    "graph.not-found"
    "graph.invalid"
    "graph.duplicate-id"
    "graph.invalid-reference"
    "transaction.failed"
    "import.busy"
    "import.invalid-session"
    "import.invalid-operation"
    "security.unauthorized"
    "security.forbidden"
    "security.origin-denied"
    "security.rate-limited"
    "control-plane.unavailable"))

(defun ensure-string (value field &optional (code "protocol.invalid-envelope"))
  (unless (and (stringp value) (plusp (length value)))
    (error 'quasar-error
           :code code
           :message (format nil "~A must be a non-empty string." field)))
  value)

(defun ensure-object (value field &optional (code "protocol.invalid-envelope"))
  (unless (object-p value)
    (error 'quasar-error
           :code code
           :message (format nil "~A must be a JSON object." field)))
  value)

(defun ensure-array (value field &optional (code "protocol.invalid-envelope"))
  (unless (array-p value)
    (error 'quasar-error
           :code code
           :message (format nil "~A must be a JSON array." field)))
  value)

(defun ensure-object-id (object field &optional (code "protocol.invalid-envelope"))
  (ensure-string (json-value object field) field code))

(defstruct (command-envelope
            (:constructor make-command-envelope))
  id
  command
  payload
  client
  workspace)

(defun decode-command (encoded)
  "Parse and validate a v1 command envelope. Returns a COMMAND-ENVELOPE."
  (handler-case
      (let* ((object (jsown:with-injective-reader (jsown:parse encoded)))
             (protocol (json-value object "protocol"))
             (id (json-value object "id"))
             (command (json-value object "command"))
             (payload (json-value object "payload" (empty-object)))
             (metadata (json-value object "metadata" (empty-object))))
        (unless (string= protocol +protocol-version+)
          (error 'quasar-error
                 :code "protocol.invalid-envelope"
                 :message (format nil "Unsupported protocol ~S; expected ~A."
                                  protocol +protocol-version+)))
        (ensure-string id "id")
        (ensure-string command "command")
        (ensure-object payload "payload")
        (let ((envelope (make-command-envelope)))
          (setf (command-envelope-id envelope) id
                (command-envelope-command envelope) command
                (command-envelope-payload envelope) payload
                (command-envelope-client envelope)
                (json-value metadata "client")
                (command-envelope-workspace envelope)
                (json-value metadata "workspace"))
          envelope))
    (quasar-error (condition)
      (error condition))
    (error (condition)
      (error 'quasar-error
             :code "protocol.invalid-envelope"
             :message (format nil "Invalid command envelope: ~A" condition)))))

(defun result-envelope (id result)
  (json-object
   (cons "protocol" +protocol-version+)
   (cons "id" id)
   (cons "status" "ok")
   (cons "result" result)))

(defun error-envelope (id code message &optional details)
  (json-object
   (cons "protocol" +protocol-version+)
   (cons "id" id)
   (cons "status" "error")
   (cons "error"
         (json-object
          (cons "code" code)
          (cons "message" message)
          (cons "details" (or details (empty-object)))))))

(defun event-envelope (event workspace-id revision operation-id payload
                       &key transaction-id event-index event-count)
  (let ((obj (json-object
              (cons "protocol" +protocol-version+)
              (cons "event" event)
              (cons "workspace" workspace-id)
              (cons "revision" revision)
              (cons "operationId" operation-id)
              (cons "payload" payload))))
    (when transaction-id
      (object-set obj "transactionId" transaction-id))
    (when event-index
      (object-set obj "eventIndex" event-index))
    (when event-count
      (object-set obj "eventCount" event-count))
    obj))

(defun normalize-for-encoding (value)
  "Convert :array-tagged values to plain lists for jsown:to-json.
  JSOWN objects use (:obj . pairs) which jsown:to-json handles natively,
  but our json-array constructor uses (:array . elements) which
  jsown:to-json does not understand — it would serialize :array as a
  string element. This function strips the :array tag, producing a plain
  list that jsown:to-json serializes as a JSON array."
  (cond
    ((and (consp value) (eq (car value) :array))
     (mapcar #'normalize-for-encoding (rest value)))
    ((object-p value)
     (cons :obj
           (loop for (key . val) in (rest value)
                 collect (cons key (normalize-for-encoding val)))))
    ((consp value)
     (mapcar #'normalize-for-encoding value))
    (t value)))

(defun encode (object)
  (jsown:to-json (normalize-for-encoding object)))

(defun encode-result (id result)
  (encode (result-envelope id result)))

(defun encode-error (id code message &optional details)
  (encode (error-envelope id code message details)))

(defun encode-event (event workspace-id revision operation-id payload
                     &key transaction-id event-index event-count)
  (encode (event-envelope event workspace-id revision operation-id payload
          :transaction-id transaction-id :event-index event-index
          :event-count event-count)))

(defun quasar-error-to-envelope (id condition)
  (encode-error (or id "")
                (quasar-error-code condition)
                (quasar-error-message condition)
                (quasar-error-details condition)))
