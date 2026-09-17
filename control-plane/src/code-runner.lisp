(in-package #:quasar.control-plane)

(defparameter +code-runner-max-source-bytes+ (* 64 1024))
(defparameter +code-runner-default-timeout-ms+ 2000)
(defparameter +code-runner-max-timeout-ms+ 10000)
(defparameter +code-runner-languages+
  '("lisp" "cl" "common-lisp" "prolog" "pl" "swi-prolog"))

(defun code-runner-path ()
  (let ((value (uiop:getenv "QUASAR_CODE_RUNNER_BIN")))
    (and value (plusp (length value)) value)))

(defun code-runner-configured-p ()
  (not (null (code-runner-path))))

(defun normalize-code-language (value)
  (let ((language (string-downcase
                   (quasar.protocol:ensure-string
                    value "language" "code.invalid-language"))))
    (unless (member language +code-runner-languages+ :test #'string=)
      (error 'quasar.protocol:quasar-error
             :code "code.unsupported-language"
             :message "This code language is not enabled by the sandbox runner."))
    language))

(defun code-timeout-ms (value)
  (let ((timeout (or value +code-runner-default-timeout-ms+)))
    (unless (and (integerp timeout)
                 (<= 100 timeout +code-runner-max-timeout-ms+))
      (error 'quasar.protocol:quasar-error
             :code "code.invalid-timeout"
             :message "Code timeout must be an integer between 100 and 10000 milliseconds."))
    timeout))

(defun bounded-code-source (value)
  (let* ((source (quasar.protocol:ensure-string value "source" "code.invalid-source"))
         (octets (babel:string-to-octets source :encoding :utf-8)))
    (when (> (length octets) +code-runner-max-source-bytes+)
      (error 'quasar.protocol:quasar-error
             :code "code.source-too-large"
             :message "Code blocks are limited to 64 KiB."))
    source))

(defun run-code-subprocess (runner language source timeout-ms)
  (handler-case
      (with-input-from-string (input source)
        (multiple-value-bind (stdout stderr exit-code)
            (uiop:run-program
             (list runner language (write-to-string timeout-ms))
             :input input
             :output :string
             :error-output :string
             :ignore-error-status t)
          (values (or stdout "")
                  (or stderr "")
                  (if (integerp exit-code) exit-code 1))))
    (error (condition)
      (error 'quasar.protocol:quasar-error
             :code "code.runner-failed"
             :message "The sandbox runner could not be started."
             :details (quasar.protocol:json-object
                       (cons "condition" (princ-to-string (type-of condition))))))))

(defun handle-code-run (payload envelope)
  (declare (ignore envelope))
  (let ((runner (code-runner-path)))
    (unless runner
      (error 'quasar.protocol:quasar-error
             :code "code.runner-disabled"
             :message "Sandboxed code execution is disabled on this Quasar host."))
    (let* ((language (normalize-code-language
                      (quasar.protocol:json-value payload "language")))
           (source (bounded-code-source
                    (quasar.protocol:json-value payload "source")))
           (timeout-ms (code-timeout-ms
                        (quasar.protocol:json-value payload "timeoutMs"))))
      (multiple-value-bind (stdout stderr exit-code)
          (run-code-subprocess runner language source timeout-ms)
        (quasar.protocol:json-object
         (cons "ok" (zerop exit-code))
         (cons "runtime" "bubblewrap")
         (cons "language" language)
         (cons "stdout" stdout)
         (cons "stderr" stderr)
         (cons "result" "")
         (cons "exitCode" exit-code)
         (cons "timeoutMs" timeout-ms))))))

(defvar *core-command-installer-without-code-runner* nil)

(defun install-code-runner-hook ()
  "Extend the core command installer without making code execution implicit.
The command exists only when QUASAR_CODE_RUNNER_BIN is configured by the host."
  (unless *core-command-installer-without-code-runner*
    (setf *core-command-installer-without-code-runner*
          (symbol-function 'install-core-commands)))
  (let ((base-installer *core-command-installer-without-code-runner*))
    (setf (symbol-function 'install-core-commands)
          (lambda (plane)
            (funcall base-installer plane)
            (when (code-runner-configured-p)
              (register-command
               plane "code.run"
               (lambda (payload envelope)
                 (handle-code-run payload envelope))))
            plane))))

(eval-when (:load-toplevel :execute)
  (install-code-runner-hook))
