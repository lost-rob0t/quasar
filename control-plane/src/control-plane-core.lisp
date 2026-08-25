(in-package #:quasar.control-plane)

(defclass control-plane ()
  ((actor-system :initform nil :accessor control-plane-actor-system)
   (command-actor :initform nil :accessor control-plane-command-actor)
   (handlers :initform (make-hash-table :test #'equal)
             :reader control-plane-handlers)
   (workspaces :initform (make-hash-table :test #'equal)
               :reader control-plane-workspaces)
   (store :initarg :store :initform (quasar.store:make-memory-store)
          :reader control-plane-store)
   (subscribers :initform (make-hash-table :test #'equal)
                :reader control-plane-subscribers)
   (import-sessions :initform (make-hash-table :test #'equal)
                    :reader control-plane-import-sessions)
   (started-p :initform nil :accessor control-plane-started-p)
   (lock :initform (bt:make-lock) :reader control-plane-lock))
  (:documentation
   "The control plane owns protocol routing and serialized mutation dispatch.
Tek9 is canonical authority for streaming-store records; the workspace cache is
only a compatibility structure for the in-memory backend and explicit legacy
materialization paths."))

(defun make-control-plane (&key (store (quasar.store:make-memory-store)))
  (make-instance 'control-plane :store store))

(defun register-command (plane name handler)
  (check-type name string)
  (check-type handler function)
  (setf (gethash name (control-plane-handlers plane)) handler)
  name)

(defun control-plane-capabilities (plane)
  (sort (loop for name being the hash-keys of (control-plane-handlers plane)
              collect name)
        #'string<))

(defun workspace-for (plane envelope)
  "Materialize the compatibility workspace for non-streaming/legacy paths.
Ordinary Tek9 mutations must not call this function."
  (let* ((workspace-id (or (quasar.protocol:command-envelope-workspace envelope)
                           "default"))
         (workspace (gethash workspace-id (control-plane-workspaces plane))))
    (unless workspace
      (let ((loaded (quasar.store:load-workspace
                     (control-plane-store plane) workspace-id)))
        (setf workspace
              (or loaded (quasar.workspace:make-workspace :id workspace-id))
              (gethash workspace-id (control-plane-workspaces plane)) workspace)))
    workspace))

(defun array-elements (value)
  "Return elements from either tagged or plain JSON array representations."
  (if (and (consp value) (eq (car value) :array))
      (rest value)
      value))

(defun subscribe (plane handler)
  (let ((id (format nil "sub-~36R" (random most-positive-fixnum))))
    (setf (gethash id (control-plane-subscribers plane)) handler)
    id))

(defun unsubscribe (plane id)
  (remhash id (control-plane-subscribers plane)))

(defun broadcast-event (plane event workspace-id revision operation-id payload
                        &key transaction-id event-index event-count)
  (let ((encoded
          (quasar.protocol:encode-event
           event workspace-id revision operation-id payload
           :transaction-id transaction-id
           :event-index event-index
           :event-count event-count)))
    (loop for handler being the hash-values of (control-plane-subscribers plane)
          do
            (handler-case
                (funcall handler encoded)
              (error (condition)
                (format *error-output*
                        "~&[control-plane] subscriber failed: ~A~%"
                        condition))))))

(defun next-operation-id ()
  (format nil "op-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defun next-transaction-id ()
  (format nil "txn-~36R-~36R"
          (get-universal-time)
          (random most-positive-fixnum)))

(defstruct import-session
  workspace
  workspace-id
  base-revision
  (document-count 0)
  (encoded-chunks (make-array 0 :adjustable t :fill-pointer 0)))

(defun import-session-for (plane payload envelope)
  (let* ((id
           (quasar.protocol:ensure-string
            (quasar.protocol:json-value payload "sessionId")
            "sessionId"
            "import.invalid-session"))
         (session (gethash id (control-plane-import-sessions plane)))
         (workspace-id
           (or (quasar.protocol:command-envelope-workspace envelope) "default")))
    (unless
        (and session
             (string= workspace-id (import-session-workspace-id session)))
      (error 'quasar.protocol:quasar-error
             :code "import.invalid-session"
             :message "The document import session does not exist."))
    (values session id)))

(defun handle-import-begin (plane payload envelope)
  (declare (ignore payload))
  (let* ((workspace (workspace-for plane envelope))
         (workspace-id (quasar.workspace:workspace-id workspace)))
    (loop for session being the hash-values of (control-plane-import-sessions plane)
          unless (string= workspace-id (import-session-workspace-id session))
            do
              (error 'quasar.protocol:quasar-error
                     :code "import.busy"
                     :message
                     "Another workspace is already importing documents."))
    (clrhash (control-plane-import-sessions plane))
    (let* ((id (next-transaction-id))
           (session
             (make-import-session
              :workspace (quasar.workspace:copy-workspace workspace)
              :workspace-id workspace-id
              :base-revision (quasar.workspace:workspace-revision workspace))))
      (setf (gethash id (control-plane-import-sessions plane)) session)
      (quasar.protocol:json-object
       (cons "sessionId" id)
       (cons "baseRevision" (import-session-base-revision session))))))

(defun handle-import-chunk (plane payload envelope)
  (multiple-value-bind (session id)
      (import-session-for plane payload envelope)
    (let ((operations
            (quasar.protocol:ensure-array
             (quasar.protocol:json-value payload "operations")
             "operations"
             "protocol.invalid-envelope")))
      (handler-case
          (progn
            (dolist (operation (array-elements operations))
              (let ((type (quasar.protocol:json-value operation "type")))
                (unless
                    (member
                     type
                     '("document.create" "document.update")
                     :test #'string=)
                  (error 'quasar.protocol:quasar-error
                         :code "import.invalid-operation"
                         :message
                         "Import chunks may only create or update documents."))
                (quasar.workspace:dispatch-operation
                 (import-session-workspace session) operation)))
            (vector-push-extend
             (quasar.protocol:encode operations)
             (import-session-encoded-chunks session))
            (incf (import-session-document-count session)
                  (length (array-elements operations)))
            (quasar.protocol:json-object
             (cons "sessionId" id)
             (cons "documentCount" (import-session-document-count session))))
        (error (condition)
          (remhash id (control-plane-import-sessions plane))
          (error condition))))))

(defun handle-import-abort (plane payload envelope)
  (multiple-value-bind (session id)
      (import-session-for plane payload envelope)
    (declare (ignore session))
    (remhash id (control-plane-import-sessions plane))
    (quasar.protocol:json-object
     (cons "sessionId" id)
     (cons "aborted" t))))

(defun handle-import-commit (plane payload envelope)
  (multiple-value-bind (session id)
      (import-session-for plane payload envelope)
    (let* ((current (workspace-for plane envelope))
           (candidate (import-session-workspace session))
           (base-revision (import-session-base-revision session)))
      (unless (= base-revision (quasar.workspace:workspace-revision current))
        (remhash id (control-plane-import-sessions plane))
        (error 'quasar.protocol:quasar-error
               :code "workspace.revision-conflict"
               :message "The workspace changed during document import."))
      (let* ((revision
               (setf (quasar.workspace:workspace-revision candidate)
                     (1+ base-revision)))
             (operation-id (next-operation-id))
             (result
               (quasar.protocol:json-object
                (cons "operationId" operation-id)
                (cons "revision" revision)
                (cons "workspaceId" (import-session-workspace-id session))
                (cons "documentCount" (import-session-document-count session)))))
        (quasar.store:commit-workspace
         (control-plane-store plane)
         candidate
         (quasar.protocol:json-object
          (cons "operationId" operation-id)
          (cons "workspaceId" (import-session-workspace-id session))
          (cons "baseRevision" base-revision)
          (cons "committedRevision" revision)
          (cons "command" "document.import")
          (cons
           "encodedChunks"
           (cons :array
                 (coerce (import-session-encoded-chunks session) 'list)))
          (cons "timestamp" (get-universal-time))
          (cons "client"
                (or
                 (quasar.protocol:command-envelope-client envelope)
                 "unknown"))))
        (setf
         (gethash
          (import-session-workspace-id session)
          (control-plane-workspaces plane))
         candidate)
        (remhash id (control-plane-import-sessions plane))
        (broadcast-event
         plane
         "documents.imported"
         (import-session-workspace-id session)
         revision
         operation-id
         result)
        result))))

(defun handle-document-list (plane payload envelope)
  (declare (ignore payload))
  (let* ((workspace (workspace-for plane envelope))
         (documents
           (loop for document being the hash-values
                   of (quasar.workspace:workspace-documents workspace)
                 collect (quasar.protocol:clone-json document))))
    (apply #'quasar.protocol:json-array documents)))

(defun handle-document-get (plane payload envelope)
  (let* ((workspace (workspace-for plane envelope))
         (id
           (quasar.protocol:ensure-string
            (quasar.protocol:json-value payload "id")
            "id"
            "document.invalid"))
         (document
           (gethash id (quasar.workspace:workspace-documents workspace))))
    (unless document
      (error 'quasar.protocol:quasar-error
             :code "document.not-found"
             :message (format nil "Document ~A does not exist." id)))
    (quasar.protocol:clone-json document)))
