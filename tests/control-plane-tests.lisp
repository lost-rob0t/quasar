(in-package #:quasar.tests)

(defvar *failures* 0)

(defmacro check (form)
  `(unless ,form
     (incf *failures*)
     (format *error-output* "~&FAIL: ~S~%" ',form)))

(defun test-protocol ()
  (multiple-value-bind (id command payload)
      (decode-command
       "{\"v\":1,\"kind\":\"command\",\"id\":\"1\",\"command\":\"ping\",\"payload\":{}}")
    (declare (ignore payload))
    (check (string= id "1"))
    (check (string= command "ping")))
  (check (search "\"ok\":true" (encode-result "1" (quasar.protocol:json-object)))))

(defun test-workspace ()
  (let ((workspace (make-workspace)))
    (check (= 0 (workspace-revision workspace)))
    (apply-workspace-operation
     workspace
     (quasar.protocol:json-object
      (cons "type" "document.save")
      (cons "payload"
            (quasar.protocol:json-object
             (cons "_id" "person:1")
             (cons "dtype" "person")))))
    (check (= 1 (workspace-revision workspace)))
    (check (search "person:1"
                   (jsown:to-json (workspace-snapshot workspace))))))

(defun run-tests ()
  (setf *failures* 0)
  (test-protocol)
  (test-workspace)
  (when (plusp *failures*)
    (error "~D Quasar test(s) failed." *failures*))
  (format t "~&Quasar tests passed.~%")
  t)
