(defpackage #:quasar.autodig.store
  (:use #:cl)
  (:export
   #:run-store
   #:journal-run-store
   #:filesystem-run-store
   #:corrupt-run-store
   #:make-journal-run-store
   #:make-filesystem-run-store
   #:append-run-event
   #:run-events
   #:close-run-store
   #:workspace-run-file))

(in-package #:quasar.autodig.store)

(define-condition corrupt-run-store (error)
  ((path :initarg :path :reader corrupt-run-store-path)
   (reason :initarg :reason :reader corrupt-run-store-reason))
  (:report (lambda (condition stream)
             (format stream "Corrupt Auto-Dig run store ~A: ~A"
                     (corrupt-run-store-path condition)
                     (corrupt-run-store-reason condition)))))

(defclass run-store () ())

(defgeneric append-run-event (store workspace-id event))
(defgeneric run-events (store workspace-id))
(defgeneric close-run-store (store))

(defclass journal-run-store (run-store)
  ((workspace-store :initarg :workspace-store :reader journal-workspace-store)))

(defun make-journal-run-store (workspace-store)
  (make-instance 'journal-run-store :workspace-store workspace-store))

(defun legacy-autodig-workspace-id (workspace-id)
  (format nil "__autodig__:~A" workspace-id))

(defmethod append-run-event ((store journal-run-store) workspace-id event)
  (quasar.store:append-operation
   (journal-workspace-store store)
   (legacy-autodig-workspace-id workspace-id)
   event)
  (quasar.protocol:clone-json event))

(defmethod run-events ((store journal-run-store) workspace-id)
  (or (quasar.store:store-journal-entries
       (journal-workspace-store store)
       (legacy-autodig-workspace-id workspace-id))
      nil))

(defmethod close-run-store ((store journal-run-store))
  store)

(defun fnv1a-64 (string)
  (let ((hash #xcbf29ce484222325))
    (loop for byte across (babel:string-to-octets string :encoding :utf-8)
          do (setf hash (ldb (byte 64 0)
                             (* (logxor hash byte) #x100000001b3))))
    hash))

(defun workspace-token (workspace-id)
  (format nil "~16,'0X" (fnv1a-64 workspace-id)))

(defclass filesystem-run-store (run-store)
  ((path :initarg :path :reader filesystem-run-store-path)
   (lock :initform (bt:make-lock "quasar-autodig-filesystem-store")
         :reader filesystem-run-store-lock)))

(defun make-filesystem-run-store (&key (path (quasar.config:default-autodig-filesystem-path)))
  (let ((path (uiop:ensure-directory-pathname path)))
    (ensure-directories-exist path)
    (make-instance 'filesystem-run-store :path path)))

(defun workspace-run-file (store workspace-id)
  "Return the bounded derived path for WORKSPACE-ID.
The caller-provided workspace text is never used as a pathname component."
  (merge-pathnames
   (make-pathname :name (format nil "workspace-~A" (workspace-token workspace-id))
                  :type "json")
   (filesystem-run-store-path store)))

(defun decode-file-object (path workspace-id)
  (handler-case
      (with-open-file (stream path :direction :input)
        (let* ((text (with-output-to-string (out)
                       (loop for line = (read-line stream nil nil)
                             while line
                             do (write-line line out))))
               (object (jsown:parse text))
               (stored-workspace (jsown:val object "workspaceId"))
               (events (jsown:val object "events")))
          (unless (and (stringp stored-workspace)
                       (string= stored-workspace workspace-id)
                       (listp events))
            (error 'corrupt-run-store
                   :path path
                   :reason "workspace identity or events payload is invalid"))
          (mapcar #'quasar.protocol:clone-json events)))
    (corrupt-run-store (condition)
      (error condition))
    (error (condition)
      (error 'corrupt-run-store :path path :reason condition))))

(defun read-workspace-events (store workspace-id)
  (let ((path (workspace-run-file store workspace-id)))
    (if (probe-file path)
        (decode-file-object path workspace-id)
        nil)))

(defun atomic-write-events (store workspace-id events)
  (let* ((target (workspace-run-file store workspace-id))
         (temporary
           (merge-pathnames
            (make-pathname :name (format nil ".tmp-~A-~36R"
                                         (workspace-token workspace-id)
                                         (random most-positive-fixnum))
                           :type "json")
            (filesystem-run-store-path store)))
         (payload
           (quasar.protocol:json-object
            (cons "workspaceId" workspace-id)
            (cons "events" (apply #'quasar.protocol:json-array
                                  (mapcar #'quasar.protocol:clone-json events))))))
    (unwind-protect
         (progn
           (with-open-file (stream temporary
                                   :direction :output
                                   :if-does-not-exist :create
                                   :if-exists :supersede)
             (write-string (quasar.protocol:encode payload) stream)
             (finish-output stream))
           (uiop:rename-file-overwriting-target temporary target))
      (when (probe-file temporary)
        (delete-file temporary)))
    target))

(defmethod append-run-event ((store filesystem-run-store) workspace-id event)
  (bt:with-lock-held ((filesystem-run-store-lock store))
    (let ((events (read-workspace-events store workspace-id)))
      (setf events (append events (list (quasar.protocol:clone-json event))))
      (atomic-write-events store workspace-id events)))
  (quasar.protocol:clone-json event))

(defmethod run-events ((store filesystem-run-store) workspace-id)
  (bt:with-lock-held ((filesystem-run-store-lock store))
    (read-workspace-events store workspace-id)))

(defmethod close-run-store ((store filesystem-run-store))
  store)

(in-package #:quasar.control-plane)

(defclass autodig-control-plane (control-plane)
  ((autodig-store :initarg :autodig-store :reader control-plane-autodig-store)))

(defun default-autodig-store (workspace-store)
  (case quasar.config:*autodig-persistence-backend*
    (:tek9
     (quasar.autodig.store:make-journal-run-store workspace-store))
    (:filesystem
     (quasar.autodig.store:make-filesystem-run-store
      :path (or quasar.config:*autodig-filesystem-path*
                (quasar.config:default-autodig-filesystem-path))))
    (otherwise
     (error "Unsupported Auto-Dig persistence backend: ~S"
            quasar.config:*autodig-persistence-backend*))))

(defun make-control-plane (&key
                             (store (quasar.store:make-memory-store))
                             autodig-store)
  (make-instance 'autodig-control-plane
                 :store store
                 :autodig-store (or autodig-store (default-autodig-store store))))
