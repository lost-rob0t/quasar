(in-package #:quasar.tests)

(defun test-phase2-v2-revision-conflict-after-restart ()
  (let* ((path (unique-tek9-test-path "phase2-conflict-restart"))
         (store-1 nil)
         (store-2 nil)
         (plane-1 nil)
         (plane-2 nil))
    (unwind-protect
         (let (session-id)
           (setf store-1 (quasar.store:make-tek9-store :path path)
                 plane-1
                 (quasar.control-plane:start-control-plane
                  (quasar.control-plane:make-control-plane :store store-1)))
           (check
            (tek9-command-ok-p
             plane-1 "document.create" (make-doc "base") :id "conflict-base"))
           (setf session-id
                 (phase2-spec-session-id (phase2-spec-begin plane-1)))
           (check
            (string=
             "ok"
             (status
              (phase2-spec-send-chunk
               plane-1
               (phase2-spec-chunk
                session-id 0 (make-doc "staged-conflict"))))))
           (check
            (tek9-command-ok-p
             plane-1
             "document.create"
             (make-doc "concurrent")
             :id "conflict-concurrent"))
           (quasar.control-plane:stop-control-plane plane-1)
           (setf plane-1 nil)
           (quasar.store:close-store store-1)
           (setf store-1 nil)
           (multiple-value-setq (store-2 plane-2)
             (phase2-spec-reopen path))
           (setf *events-box* (cons nil nil))
           (let ((subscriber-id
                   (quasar.control-plane:subscribe
                    plane-2 (event-collector))))
             (unwind-protect
                  (let ((response
                          (phase2-spec-commit plane-2 session-id)))
                    (check (string= "error" (status response)))
                    (check
                     (string=
                      "workspace.revision-conflict"
                      (error-code response)))
                    (check
                     (= 2
                        (quasar.store:direct-workspace-revision
                         store-2 "default")))
                    (check
                     (string=
                      "document.not-found"
                      (error-code
                       (call-command
                        plane-2
                        (make-envelope
                         "document.get"
                         (quasar.protocol:json-object
                          (cons "id" "staged-conflict"))
                         :id "conflict-staged-missing")))))
                    (check
                     (string=
                      "ok"
                      (status
                       (call-command
                        plane-2
                        (make-envelope
                         "document.get"
                         (quasar.protocol:json-object
                          (cons "id" "concurrent"))
                         :id "conflict-concurrent-present")))))
                    (check (= 0 (phase2-v2-import-event-count)))
                    (check
                     (notany
                      (lambda (entry)
                        (let ((command
                                (quasar.protocol:json-value
                                 entry "command" nil)))
                          (and command
                               (string=
                                "document.import"
                                (or
                                 (quasar.protocol:json-value
                                  command "type" nil)
                                 "")))))
                      (quasar.store:store-journal-entries
                       store-2 "default")))
                    (let ((retry
                            (phase2-spec-commit
                             plane-2 session-id :id "conflict-retry")))
                      (check (string= "error" (status retry)))
                      (check
                       (string=
                        "import.invalid-session"
                        (error-code retry)))))
               (quasar.control-plane:unsubscribe
                plane-2 subscriber-id))))
      (when plane-1
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-1)))
      (when plane-2
        (ignore-errors
          (quasar.control-plane:stop-control-plane plane-2)))
      (when store-1
        (ignore-errors (quasar.store:close-store store-1)))
      (when store-2
        (ignore-errors (quasar.store:close-store store-2)))
      (when (probe-file path)
        (uiop:delete-directory-tree
         path :validate t :if-does-not-exist :ignore)))))
