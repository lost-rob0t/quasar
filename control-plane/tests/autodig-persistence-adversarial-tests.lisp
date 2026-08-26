(in-package #:quasar.tests)

(defvar *autodig-persistence-adversarial-failures* 0)

(defmacro autodig-persistence-adversarial-check (form)
  `(unless ,form
     (incf *autodig-persistence-adversarial-failures*)
     (format *error-output* "~&FAIL autodig-persistence-adversarial: ~S~%" ',form)))

(defun test-filesystem-restart-preserves-request-conflict ()
  (let ((root (make-autodig-temp-directory "autodig-fs-conflict")))
    (unwind-protect
         (progn
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (start-autodig-run plane "conflict-request-1"
                                     "first.example" "conflict-workspace")
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store)))
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (let ((response (start-autodig-run plane "conflict-request-1"
                                                     "changed.example"
                                                     "conflict-workspace")))
                    (autodig-persistence-adversarial-check
                     (string= (status response) "error"))
                    (autodig-persistence-adversarial-check
                     (string= (error-code response) "autodig.request-conflict")))
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store))))
      (cleanup-autodig-temp-directory root))))

(defun persisted-run-status (root workspace run-id)
  (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
         (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (jsown:val (result (get-autodig-run plane run-id workspace)) "status")
      (quasar.control-plane:stop-control-plane plane)
      (quasar.autodig.store:close-run-store run-store))))

(defun apply-persisted-transition (root workspace run-id command id)
  (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
         (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (transition-autodig-run plane command run-id workspace id)
      (quasar.control-plane:stop-control-plane plane)
      (quasar.autodig.store:close-run-store run-store))))

(defun test-filesystem-transitions-survive-each-restart ()
  (let ((root (make-autodig-temp-directory "autodig-fs-transitions"))
        (workspace "transition-restart-workspace")
        (run-id nil))
    (unwind-protect
         (progn
           (let* ((run-store (quasar.autodig.store:make-filesystem-run-store :path root))
                  (plane (quasar.control-plane:make-control-plane :autodig-store run-store)))
             (quasar.control-plane:start-control-plane plane)
             (unwind-protect
                  (setf run-id
                        (autodig-run-id
                         (start-autodig-run plane "transition-restart-request"
                                            "transition-restart.example"
                                            workspace)))
               (quasar.control-plane:stop-control-plane plane)
               (quasar.autodig.store:close-run-store run-store)))
           (apply-persisted-transition root workspace run-id
                                       "autodig.run.pause" "restart-pause")
           (autodig-persistence-adversarial-check
            (string= (persisted-run-status root workspace run-id) "paused"))
           (apply-persisted-transition root workspace run-id
                                       "autodig.run.resume" "restart-resume")
           (autodig-persistence-adversarial-check
            (string= (persisted-run-status root workspace run-id) "queued"))
           (apply-persisted-transition root workspace run-id
                                       "autodig.run.stop" "restart-stop")
           (autodig-persistence-adversarial-check
            (string= (persisted-run-status root workspace run-id) "stopped")))
      (cleanup-autodig-temp-directory root))))

(defun test-default-autodig-backend-preserves-legacy-journal-semantics ()
  (quasar.config:reset-config)
  (let* ((store (quasar.store:make-memory-store))
         (plane (quasar.control-plane:make-control-plane :store store)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (progn
           (start-autodig-run plane "legacy-request" "legacy.example" "legacy-workspace")
           (autodig-persistence-adversarial-check
            (typep (quasar.control-plane::control-plane-autodig-store plane)
                   'quasar.autodig.store:journal-run-store))
           (autodig-persistence-adversarial-check
            (= 1 (length (quasar.store:store-journal-entries
                          store "__autodig__:legacy-workspace")))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-explicit-init_argument_wins_over_default ()
  (let* ((root (make-autodig-temp-directory "quasar-init-precedence"))
         (explicit (merge-pathnames #P"explicit.lisp" root))
         (resolved (quasar.config:resolve-init-path
                    (list "--init" (namestring explicit)))))
    (unwind-protect
         (autodig-persistence-adversarial-check
          (equal (uiop:ensure-pathname explicit :want-file t) resolved))
      (cleanup-autodig-temp-directory root))))

(defun run-autodig-persistence-adversarial-tests ()
  (setf *autodig-persistence-adversarial-failures* 0)
  (test-filesystem-restart-preserves-request-conflict)
  (test-filesystem-transitions-survive-each-restart)
  (test-default-autodig-backend-preserves-legacy-journal-semantics)
  (test-explicit-init_argument_wins_over_default)
  (when (plusp *autodig-persistence-adversarial-failures*)
    (error "Auto-Dig persistence adversarial tests failed: ~D"
           *autodig-persistence-adversarial-failures*))
  t)
