(in-package #:quasar.tests)

(defun run-plugin-tests ()
  (let ((failures-before *failures*))
    (format t "~&Running plugin policy tests...~%")
    (quasar.plugin:reset-plugin-policy)
    (check (= quasar.plugin:*default-user-storage-bytes*
              (* 5 1024 1024 1024)))
    (let ((events nil)
        (plane (quasar.control-plane:make-control-plane
                :store (quasar.store:make-memory-store))))
      (let ((server (quasar.ws:make-websocket-server plane)))
        (quasar.plugin:add-session-registered-hook
         (lambda (principal workspaces capabilities authority-kind)
           (push (list principal workspaces capabilities authority-kind) events)))
      (quasar.ws:register-websocket-session
       server "token" "alice" '("alice") :capabilities '("document.list")
       :authority-kind :starintel-server)
      (check (equal (caar events) "alice"))
      (check (quasar.ws:websocket-session-active-p server "token"))
      (check (quasar.ws:unregister-websocket-session server "token"))
      (check (not (quasar.ws:websocket-session-active-p server "token")))
      (check (not (quasar.ws:unregister-websocket-session server "token")))
      (quasar.ws:register-websocket-session
       server "expired" "alice" '("alice") :expires-at 1)
      (check (not (quasar.ws:websocket-session-active-p
                   server "expired" (get-universal-time))))))
    (handler-case
        (quasar.plugin:authorize-actor-spawn
         "alice" '(:sandboxed-p nil :actor "unsafe"))
      (error () (check t))
      (:no-error (&rest values) (declare (ignore values)) (check nil)))
    (let ((workspace (quasar.workspace:make-workspace :id "alice")))
      (quasar.plugin:set-storage-quota-resolver
       (lambda (principal) (declare (ignore principal)) 1))
      (handler-case
          (quasar.plugin:authorize-storage-commit "alice" workspace)
        (quasar.protocol:quasar-error (condition)
          (check (string= "storage.quota-exceeded"
                          (quasar.protocol:quasar-error-code condition))))
        (:no-error (&rest values) (declare (ignore values)) (check nil))))
    (quasar.plugin:reset-plugin-policy)
    (when (> *failures* failures-before)
      (error "Plugin policy tests failed."))
    (format t "Plugin policy tests complete.~%")
    t))
