(in-package #:quasar.tests)

(defvar *autodig-persistence-failures* 0)

(defmacro autodig-persistence-check (form)
  `(unless ,form
     (incf *autodig-persistence-failures*)
     (format *error-output* "~&FAIL autodig-persistence: ~S~%" ',form)))

(defun make-autodig-temp-directory (name)
  (let ((path (merge-pathnames
               (format nil "quasar-~A-~36R/" name (random most-positive-fixnum))
               (uiop:temporary-directory))))
    (ensure-directories-exist path)
    path))

(defun cleanup-autodig-temp-directory (path)
  (when (probe-file path)
    (uiop:delete-directory-tree path :validate t :if-does-not-exist :ignore)))

(defun test-filesystem-autodig-run-survives-restart ()
  (let ((root (make-autodig-temp-directory "autodig-fs-restart")))
    (unwind-protect
         (let ((run-id nil))
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (setf run-id
                        (autodig-run-id
                         (start-autodig-run plane "persist-request-1"
                                            "persist.example"
                                            "persist-workspace")))
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store)))
           (autodig-persistence-check run-id)
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (let ((lookup (get-autodig-run plane run-id "persist-workspace"))
                        (replay (start-autodig-run plane "persist-request-1"
                                                   "persist.example"
                                                   "persist-workspace")))
                    (autodig-persistence-check (string= (status lookup) "ok"))
                    (autodig-persistence-check
                     (string= (autodig-run-id replay) run-id)))
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store))))
      (cleanup-autodig-temp-directory root))))

(defun test-filesystem-autodig-transition-and-worker-lease-survive-restart ()
  (let ((root (make-autodig-temp-directory "autodig-fs-state")))
    (unwind-protect
         (let ((run-id nil) (lease-id nil))
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (let* ((start (start-autodig-run plane "state-request-1"
                                                    "state.example"
                                                    "state-workspace"))
                         (id (autodig-run-id start))
                         (claim (worker-autodig-command
                                 plane "autodig.worker.claim" id
                                 "state-workspace" "worker-persist")))
                    (setf run-id id
                          lease-id (jsown:val (result claim) "leaseId")))
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store)))
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (let ((heartbeat (worker-autodig-command
                                    plane "autodig.worker.heartbeat" run-id
                                    "state-workspace" "worker-persist"
                                    :lease-id lease-id)))
                    (autodig-persistence-check (string= (status heartbeat) "ok")))
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store))))
      (cleanup-autodig-temp-directory root))))

(defun test-filesystem-store-never-uses-workspace-as-path-component ()
  (let ((root (make-autodig-temp-directory "autodig-fs-path")))
    (unwind-protect
         (let ((store (quasar.autodig.store:make-filesystem-run-store :path root)))
           (unwind-protect
                (progn
                  (quasar.autodig.store:append-run-event
                   store "../../escape"
                   (quasar.protocol:json-object
                    (cons "committedRevision" 1)
                    (cons "operationId" "path-test")
                    (cons "run" (quasar.protocol:json-object
                                  (cons "runId" "run-path")))))
                  (autodig-persistence-check
                   (= (length (quasar.autodig.store:run-events store "../../escape")) 1))
                  (autodig-persistence-check
                   (not (probe-file (merge-pathnames #P"../escape" root)))))
             (quasar.autodig.store:close-run-store store)))
      (cleanup-autodig-temp-directory root))))

(defun test-filesystem-corruption-fails-closed ()
  (let ((root (make-autodig-temp-directory "autodig-fs-corrupt")))
    (unwind-protect
         (let* ((store (quasar.autodig.store:make-filesystem-run-store :path root))
                (path (quasar.autodig.store:workspace-run-file store "corrupt-workspace")))
           (unwind-protect
                (progn
                  (ensure-directories-exist path)
                  (with-open-file (stream path :direction :output :if-exists :supersede)
                    (write-string "{truncated" stream))
                  (autodig-persistence-check
                   (handler-case
                       (progn
                         (quasar.autodig.store:run-events store "corrupt-workspace")
                         nil)
                     (quasar.autodig.store:corrupt-run-store () t))))
             (quasar.autodig.store:close-run-store store)))
      (cleanup-autodig-temp-directory root))))

(defun test-quasar-initfile-selects-autodig-backend ()
  (let ((root (make-autodig-temp-directory "quasar-init")))
    (unwind-protect
         (let ((init (merge-pathnames #P"init.lisp" root))
               (data (merge-pathnames #P"runs/" root)))
           (quasar.config:reset-config)
           (with-open-file (stream init :direction :output :if-does-not-exist :create)
             (format stream "(in-package #:quasar.config)~%")
             (format stream "(setf *autodig-persistence-backend* :filesystem~%")
             (format stream "      *autodig-filesystem-path* #P~S)~%"
                     (namestring data)))
           (quasar.config:load-init-file init)
           (autodig-persistence-check
            (eq quasar.config:*autodig-persistence-backend* :filesystem))
           (autodig-persistence-check
            (equal (uiop:ensure-directory-pathname data)
                   (uiop:ensure-directory-pathname
                    quasar.config:*autodig-filesystem-path*))))
      (quasar.config:reset-config)
      (cleanup-autodig-temp-directory root))))

(defun test-missing-initfile-is-created-from-example-and-invalid-init-fails ()
  (let ((root (make-autodig-temp-directory "quasar-init-create")))
    (unwind-protect
         (let ((init (merge-pathnames #P"nested/init.lisp" root)))
           (autodig-persistence-check (not (probe-file init)))
           (quasar.config:ensure-init-file init)
           (autodig-persistence-check (probe-file init))
           (with-open-file (stream init :direction :output :if-exists :supersede)
             (write-string "(this-is-not-valid-quasar-config" stream))
           (autodig-persistence-check
            (handler-case
                (progn (quasar.config:load-init-file init) nil)
              (error () t))))
      (cleanup-autodig-temp-directory root))))

(defun run-autodig-persistence-tests ()
  (setf *autodig-persistence-failures* 0)
  (test-filesystem-autodig-run-survives-restart)
  (test-filesystem-autodig-transition-and-worker-lease-survive-restart)
  (test-filesystem-store-never-uses-workspace-as-path-component)
  (test-filesystem-corruption-fails-closed)
  (test-quasar-initfile-selects-autodig-backend)
  (test-missing-initfile-is-created-from-example-and-invalid-init-fails)
  (when (plusp *autodig-persistence-failures*)
    (error "Auto-Dig persistence tests failed: ~D" *autodig-persistence-failures*))
  t)
