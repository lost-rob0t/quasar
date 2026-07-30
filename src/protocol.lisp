(in-package #:quasar.protocol)

(defconstant +protocol-version+ 1)

(define-condition protocol-error (error)
  ((message :initarg :message :reader protocol-error-message))
  (:report (lambda (condition stream)
             (write-string (protocol-error-message condition) stream))))

(defun json-object (&rest pairs)
  (cons :obj pairs))

(defun json-array (&rest values)
  (cons :array values))

(defun json-value (object key &optional default)
  (handler-case
      (jsown:val object key)
    (error () default)))

(defun ensure-string (value field)
  (unless (and (stringp value) (plusp (length value)))
    (error 'protocol-error
           :message (format nil "~A must be a non-empty string." field)))
  value)

(defun decode-command (encoded)
  (handler-case
      (let* ((object (jsown:parse encoded))
             (version (json-value object "v"))
             (id (json-value object "id"))
             (command (json-value object "command"))
             (payload (json-value object "payload" (json-object))))
        (unless (eql version +protocol-version+)
          (error 'protocol-error
                 :message (format nil "Unsupported protocol version ~S." version)))
        (values (ensure-string id "id")
                (ensure-string command "command")
                payload))
    (protocol-error (condition)
      (error condition))
    (error (condition)
      (error 'protocol-error
             :message (format nil "Invalid command envelope: ~A" condition)))))

(defun envelope (kind id &rest pairs)
  (apply #'json-object
         (append (list (cons "v" +protocol-version+)
                       (cons "kind" kind)
                       (cons "id" id))
                 pairs)))

(defun encode-result (id value)
  (jsown:to-json
   (envelope "result" id (cons "ok" t) (cons "value" value))))

(defun encode-error (id code message &optional details)
  (jsown:to-json
   (envelope "result"
             id
             (cons "ok" nil)
             (cons "error"
                   (json-object
                    (cons "code" code)
                    (cons "message" message)
                    (cons "details" (or details (json-object))))))))

(defun encode-event (name payload &optional (id "event"))
  (jsown:to-json
   (envelope "event"
             id
             (cons "event" name)
             (cons "payload" payload))))
