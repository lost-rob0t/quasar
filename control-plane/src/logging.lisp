(defpackage #:quasar.log
  (:use #:cl)
  (:import-from #:quasar.config
                #:*log-sink*
                #:*log-file-path*
                #:*log-level*
                #:*log-file-format*
                #:*log-immediate-flush*
                #:default-log-file-path)
  (:export
   #:log-config-error
   #:log-config-error-message
   #:valid-log-level-p
   #:parse-log-level
   #:log-level-rank
   #:configured-log-level
   #:resolve-log-level
   #:event-timestamp
   #:log-event
   #:log-debug
   #:log-info
   #:log-warn
   #:log-error
   #:log-fatal
   #:apply-config
   #:flush-logs
   #:shutdown-logging
   #:text-layout
   #:json-lines-layout
   #:make-text-layout
   #:make-json-lines-layout
   #:render-text-event
   #:render-json-event
   #:event-logger
   #:ensure-event-logger))

(in-package #:quasar.log)

(define-condition log-config-error (error)
  ((message :initarg :message :reader log-config-error-message))
  (:report (lambda (condition stream)
             (format stream "Quasar logging configuration error: ~A"
                     (log-config-error-message condition)))))

(defun log-config-failure (format-control &rest arguments)
  (error 'log-config-error
         :message (apply #'format nil format-control arguments)))

;;; --- Levels ------------------------------------------------------------

(defun valid-log-level-p (value)
  (member value '(:debug :info :warn :error :fatal :off) :test #'eq))

(defun log-level-rank (level)
  "Severity rank where a record is emitted when its rank is >= the
configured rank. Mirrors the historical Quasar ordering; the new
facility delegates filtering to the log4cl hierarchy but keeps this
predicate for compatibility."
  (ecase level
    (:fatal 0)
    (:error 10)
    (:warn 20)
    (:info 30)
    (:debug 40)
    (:off 100)))

(defun parse-log-level (value)
  "Parse VALUE as a Quasar log level keyword.

Signals LOG-CONFIG-ERROR for unknown levels so configuration fails
closed instead of silently falling back."
  (let ((name (string-downcase (string (or value "debug")))))
    (cond
      ((string= name "debug") :debug)
      ((string= name "info") :info)
      ((member name '("warn" "warning") :test #'string=) :warn)
      ((string= name "error") :error)
      ((string= name "fatal") :fatal)
      ((string= name "off") :off)
      (t (log-config-failure
          "unknown log level ~S (expected debug, info, warn, error, fatal, or off)."
          value)))))

(defun configured-log-level ()
  "Resolve the log level from the environment.

Local developer processes are intentionally verbose by default. CI is
quieter unless QUASAR_LOG_LEVEL=debug is explicitly requested. Unknown
environment values fail closed."
  (parse-log-level
   (or (uiop:getenv "QUASAR_LOG_LEVEL")
       (and (uiop:getenv "CI") "info")
       "debug")))

(defun resolve-log-level (init-file-level)
  "INIT-FILE-LEVEL wins when set; otherwise the environment chain in
CONFIGURED-LOG-LEVEL applies."
  (if init-file-level
      (parse-log-level init-file-level)
      (configured-log-level)))

(defun log4cl-level-number (level)
  (ecase level
    (:fatal log4cl:+log-level-fatal+)
    (:error log4cl:+log-level-error+)
    (:warn log4cl:+log-level-warn+)
    (:info log4cl:+log-level-info+)
    (:debug log4cl:+log-level-debug+)
    (:off log4cl:+log-level-off+)))

(defun level-keyword (level-number)
  (cond
    ((>= level-number log4cl:+log-level-debug+) :debug)
    ((>= level-number log4cl:+log-level-info+) :info)
    ((>= level-number log4cl:+log-level-warn+) :warn)
    ((>= level-number log4cl:+log-level-error+) :error)
    (t :fatal)))

(defun event-timestamp (&optional (universal-time (get-universal-time)))
  "Render UNIVERSAL-TIME as an ISO 8601 UTC timestamp."
  (multiple-value-bind (second minute hour day month year)
      (decode-universal-time universal-time 0)
    (format nil "~4,'0D-~2,'0D-~2,'0DT~2,'0D:~2,'0D:~2,'0DZ"
            year month day hour minute second)))

;;; --- Event record state -----------------------------------------------
;;; Bound by LOG-EVENT around the log4cl dispatch; layouts read them in
;;; the same dynamic extent, so no state is retained or shared.

(defvar *log-event-subsystem* nil)
(defvar *log-event-event* nil)
(defvar *log-event-fields* nil)
(defvar *log-event-universal-time* nil)

(defun field-value (fields name)
  (loop for (key value) on fields by #'cddr
        when (eq key name)
          do (return-from field-value value))
  nil)

(defun drop-field (fields name)
  (loop for (key value) on fields by #'cddr
        unless (eq key name)
          append (list key value)))

;;; --- JSON encoding -----------------------------------------------------

(defun json-escaped-string (string stream)
  (write-char #\" stream)
  (loop for char across string
        do (case char
             (#\" (write-string "\\\"" stream))
             (#\\ (write-string "\\\\" stream))
             (#\newline (write-string "\\n" stream))
             (#\return (write-string "\\r" stream))
             (#\tab (write-string "\\t" stream))
             (#\backspace (write-string "\\b" stream))
             (#\page (write-string "\\f" stream))
             (t
              (if (char< char #\space)
                  (format stream "\\u~4,'0X" (char-code char))
                  (write-char char stream)))))
  (write-char #\" stream))

(defun json-field-name (key)
  (let ((name (string-downcase (string key))))
    (string-right-trim ":" (substitute #\_ #\- name))))

(defun json-value-string (value stream)
  (typecase value
    (string (json-escaped-string value stream))
    (null (write-string "null" stream))
    ((eql :null) (write-string "null" stream))
    ((eql t) (write-string "true" stream))
    (real (princ value stream))
    (symbol (json-escaped-string (string-downcase (symbol-name value)) stream))
    (cons
     (case (car value)
       (:obj
        (write-char #\{ stream)
        (loop for (key . pair-value) in (cdr value)
              for first-p = t then nil
              unless first-p do (write-char #\, stream)
              do (json-escaped-string (json-field-name key) stream)
                 (write-char #\: stream)
                 (json-value-string pair-value stream))
        (write-char #\} stream))
       (:array
        (write-char #\[ stream)
        (loop for element in (cdr value)
              for first-p = t then nil
              unless first-p do (write-char #\, stream)
              do (json-value-string element stream))
        (write-char #\] stream))
       (t
        (json-escaped-string (princ-to-string value) stream))))
    (t (json-escaped-string (princ-to-string value) stream))))

(defun json-fields-string (fields stream)
  (write-char #\{ stream)
  (loop for (key value) on fields by #'cddr
        for first-p = t then nil
        unless first-p do (write-char #\, stream)
        do (json-escaped-string (json-field-name key) stream)
           (write-char #\: stream)
           (json-value-string value stream))
  (write-char #\} stream))

;;; --- Layouts -----------------------------------------------------------

(defclass text-layout (log4cl:layout)
  ()
  (:documentation "One event per line in the historical Quasar
diagnostic style: [quasar] ISO8601Z LEVEL subsystem event key=value..."))

(defclass json-lines-layout (log4cl:layout)
  ()
  (:documentation "One event per line as a single JSON object with
timestamp, level, subsystem, event, message, and structured field
context."))

(defun make-text-layout () (make-instance 'text-layout))

(defun make-json-lines-layout () (make-instance 'json-lines-layout))

(defun event-record-parts (log-func)
  "Return the subsystem, event name, field plist, and message for the
record being emitted. LOG-FUNC is only consulted for records that did
not come from LOG-EVENT (raw log4cl users of this category)."
  (values *log-event-subsystem*
          *log-event-event*
          *log-event-fields*
          (and (null *log-event-subsystem*)
               (with-output-to-string (stream)
                 (funcall log-func stream)))))

(defmethod log4cl:layout-to-stream ((layout text-layout)
                                    stream logger level log-func)
  (declare (ignore logger))
  (multiple-value-bind (subsystem event fields message)
      (event-record-parts log-func)
    (format stream "[quasar] ~A ~A"
            (event-timestamp (or *log-event-universal-time*
                                 (get-universal-time)))
            (string-upcase (symbol-name (level-keyword level))))
    (cond
      (subsystem
       (format stream " ~A ~A" subsystem event)
       (loop for (key value) on fields by #'cddr
             do (format stream " ~A=~S" key value)))
      (t
       (format stream " ~A" message)))
    (terpri stream)))

(defmethod log4cl:layout-to-stream ((layout json-lines-layout)
                                    stream logger level log-func)
  (declare (ignore logger))
  (multiple-value-bind (subsystem event fields message)
      (event-record-parts log-func)
    (let ((message (or (and fields (field-value fields :message))
                       (and (null subsystem) message))))
      (write-char #\{ stream)
      (macrolet ((json-slot (name value-stream-form)
                   `(progn
                      (unless first-p (write-char #\, stream))
                      (setf first-p nil)
                      (json-escaped-string ,name stream)
                      (write-char #\: stream)
                      ,value-stream-form)))
        (let ((first-p t)
              (remaining-fields
                (if fields
                    (drop-field
                     (drop-field (drop-field fields :message) :request-id)
                     :workspace))))
          (json-slot "timestamp"
                     (json-escaped-string
                      (event-timestamp (or *log-event-universal-time*
                                           (get-universal-time)))
                      stream))
          (json-slot "level"
                     (json-escaped-string
                      (string-downcase (symbol-name (level-keyword level)))
                      stream))
          (json-slot "subsystem"
                     (if subsystem
                         (json-escaped-string subsystem stream)
                         (write-string "null" stream)))
          (json-slot "event"
                     (if event
                         (json-escaped-string event stream)
                         (write-string "null" stream)))
          (json-slot "message"
                     (if message
                         (json-escaped-string message stream)
                         (write-string "null" stream)))
          (json-slot "fields" (json-fields-string remaining-fields stream))
          (when (and fields (field-value fields :request-id))
            (json-slot "request_id"
                       (json-value-string (field-value fields :request-id) stream)))
          (when (and fields (field-value fields :workspace))
            (json-slot "workspace_id"
                       (json-value-string (field-value fields :workspace) stream))))
        (write-char #\} stream)
        (terpri stream)))))

;;; --- Sinks -------------------------------------------------------------

(defun validate-sink-config (sink file-path file-format)
  (unless (member sink '(:stdout :stderr :file :off) :test #'eq)
    (log-config-failure
     "unknown log sink ~S (expected :stdout, :stderr, :file, or :off)." sink))
  (unless (member file-format '(:json :text) :test #'eq)
    (log-config-failure
     "unknown log file format ~S (expected :json or :text)." file-format))
  (unless (or (null file-path)
              (pathnamep file-path)
              (and (stringp file-path) (plusp (length file-path))))
    (log-config-failure
     "*log-file-path* must be a pathname designator.")))

(defun make-sink-appender (sink file-path file-format immediate-flush)
  (ecase sink
    (:stdout
     (make-instance 'log4cl:fixed-stream-appender
                    :stream *standard-output*
                    :immediate-flush immediate-flush
                    :layout (make-text-layout)))
    (:stderr
     (make-instance 'log4cl:fixed-stream-appender
                    :stream *error-output*
                    :immediate-flush immediate-flush
                    :layout (make-text-layout)))
    (:file
     (make-instance 'log4cl:file-appender
                    :file file-path
                    :immediate-flush immediate-flush
                    :layout (ecase file-format
                              (:json (make-json-lines-layout))
                              (:text (make-text-layout)))))
    (:off nil)))

(defvar *config-lock* (bt:make-lock "quasar-log-config"))

(defvar *event-logger* nil
  "Log4cl logger carrying every Quasar diagnostic event.")

(defun event-logger () *event-logger*)

(defun ensure-event-logger ()
  "Return the event logger, configuring default stdout logging on
first use so early events are never silently dropped."
  (or *event-logger*
      (progn
        (bt:with-lock-held (*config-lock*)
          (unless *event-logger*
            (apply-config))
          *event-logger*))))

(defun apply-config (&key (sink nil sink-supplied-p)
                          (file-path nil file-path-supplied-p)
                          (level nil level-supplied-p)
                          (file-format nil file-format-supplied-p)
                          (immediate-flush nil immediate-flush-supplied-p))
  "Configure the Quasar logging facility.

Arguments left as NIL default to the corresponding quasar.config
special variables, so an init file only needs to set the variables it
cares about. Configuration errors signal LOG-CONFIG-ERROR before any
sink state changes, and never leave a half-configured facility behind."
  (bt:with-lock-held (*config-lock*)
    (let* ((config-sink (if sink-supplied-p sink *log-sink*))
           (config-file-path (if file-path-supplied-p file-path *log-file-path*))
           (config-level (if level-supplied-p level *log-level*))
           (config-file-format (if file-format-supplied-p file-format *log-file-format*))
           (config-immediate-flush
             (if immediate-flush-supplied-p immediate-flush *log-immediate-flush*))
           (resolved-level (resolve-log-level config-level))
           (empty-path-p
             (and (stringp config-file-path)
                  (zerop (length config-file-path))))
           (file-pathname
             (and (eq config-sink :file)
                  (or (and (pathnamep config-file-path) config-file-path)
                      (and config-file-path (pathname config-file-path))
                      (default-log-file-path)))))
      ;; Validation runs before any sink state changes, so a rejected
      ;; configuration leaves the previous setup untouched.
      (validate-sink-config config-sink config-file-path config-file-format)
      (when empty-path-p
        (log-config-failure
         "log sink :file requires a non-empty *log-file-path* pathname."))
      (unless *event-logger*
        ;; Explicit category list: a no-argument MAKE-LOGGER would
        ;; capture the enclosing file/function naming context.
        (setf *event-logger* (log4cl:make-logger '("quasar" "log"))))
      (log4cl:remove-all-appenders *event-logger*)
      (setf (log4cl:logger-additivity *event-logger*) nil)
      (log4cl:set-log-level *event-logger* resolved-level)
      (let ((appender (make-sink-appender config-sink
                                          file-pathname
                                          config-file-format
                                          config-immediate-flush)))
        (when appender
          (log4cl:add-appender *event-logger* appender)))
      resolved-level)))

(defun flush-logs ()
  "Flush every configured log sink."
  (when *event-logger*
    (log4cl:flush-all-appenders))
  t)

(defun shutdown-logging ()
  "Flush and release every configured log sink.

Safe to call repeatedly and after a failed configuration; appenders
detach and the file appender closes its stream when its last logger
reference goes away."
  (when *event-logger*
    (log4cl:remove-all-appenders *event-logger*))
  t)

;;; --- Event API ---------------------------------------------------------

(defun event-enabled-p (level)
  ;; Level numbers grow less severe as they increase, so a record is
  ;; enabled when its level number does not exceed the effective
  ;; logger level. IS-ENABLED-FOR is not part of log4cl's public
  ;; package, so derive the answer from EFFECTIVE-LOG-LEVEL.
  (and *event-logger*
       (not (eq level :off))
       (<= (log4cl-level-number level)
           (log4cl:effective-log-level *event-logger*))))

(defun log-event (level subsystem event &rest fields)
  "Emit one structured Quasar event.

LEVEL is one of :debug :info :warn :error :fatal. SUBSYSTEM and EVENT
preserve the historical vocabulary (for example \"control-plane\"
\"command.received\"). FIELDS is a property list of structured
context; :request-id and :workspace are lifted into dedicated JSON
sink fields, and :message carries a human-readable message.

Returns NIL and never signals: sink failures are contained by the
log4cl appender error path so logging can never crash Quasar."
  (when (event-enabled-p level)
    (let ((*log-event-subsystem* subsystem)
          (*log-event-event* event)
          (*log-event-fields* fields)
          (*log-event-universal-time* (get-universal-time)))
      ;; The log4cl macros are the public emit path; the :logger form
      ;; is resolved at runtime and appender errors are contained.
      (case level
        (:debug (log4cl:log-debug :logger *event-logger* "quasar-event"))
        (:info (log4cl:log-info :logger *event-logger* "quasar-event"))
        (:warn (log4cl:log-warn :logger *event-logger* "quasar-event"))
        (:error (log4cl:log-error :logger *event-logger* "quasar-event"))
        (:fatal (log4cl:log-fatal :logger *event-logger* "quasar-event")))))
  nil)

(defun log-debug (subsystem event &rest fields)
  (apply #'log-event :debug subsystem event fields))

(defun log-info (subsystem event &rest fields)
  (apply #'log-event :info subsystem event fields))

(defun log-warn (subsystem event &rest fields)
  (apply #'log-event :warn subsystem event fields))

(defun log-error (subsystem event &rest fields)
  (apply #'log-event :error subsystem event fields))

(defun log-fatal (subsystem event &rest fields)
  (apply #'log-event :fatal subsystem event fields))
