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
  (and (consp value) (eq (car value) :array)))

(defun object-keys (object)
  (mapcar #'car (rest object)))

(defun object-set (object key value)
  (setf (jsown:val object key) value)
  object)

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
    "graph.node-not-found"
    "graph.edge-not-found"
    "graph.invalid-reference"
    "transaction.failed"
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
      (let* ((object (jsown:parse encoded))
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

(defun event-envelope (event workspace-id revision operation-id payload)
  (json-object
   (cons "protocol" +protocol-version+)
   (cons "event" event)
   (cons "workspace" workspace-id)
   (cons "revision" revision)
   (cons "operationId" operation-id)
   (cons "payload" payload)))

(defun encode (object)
  (jsown:to-json object))

(defun encode-result (id result)
  (encode (result-envelope id result)))

(defun encode-error (id code message &optional details)
  (encode (error-envelope id code message details)))

(defun encode-event (event workspace-id revision operation-id payload)
  (encode (event-envelope event workspace-id revision operation-id payload)))

(defun quasar-error-to-envelope (id condition)
  (encode-error id
                (quasar-error-code condition)
                (quasar-error-message condition)
                (quasar-error-details condition)))
