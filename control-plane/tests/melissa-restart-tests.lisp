(in-package #:quasar.tests)

(defun test-melissa-stop-restart ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (dotimes (iteration 3)
             (quasar.actors.melissa.bridge:start-melissa-integration
              plane
              :config (quasar.actors.melissa:make-melissa-config :license-key "test")
              :worker-count 2
              :transport #'fake-melissa-transport)
             (check
              (member "melissa.request"
                      (quasar.control-plane:control-plane-capabilities plane)
                      :test #'string=))
             (check
              (member "melissa.status"
                      (quasar.control-plane:control-plane-capabilities plane)
                      :test #'string=))
             (let* ((request-id (format nil "melissa-restart-~D" iteration))
                    (entity-id (format nil "person:restart-~D" iteration))
                    (entity
                      (quasar.protocol:json-object
                       (cons "_id" entity-id)
                       (cons "dataset" "test")
                       (cons "dtype" "person")
                       (cons "title" (format nil "Restart ~D" iteration))
                       (cons "data"
                             (quasar.protocol:json-object
                              (cons "name" (format nil "Restart ~D" iteration))))
                       (cons "extensions" (quasar.protocol:json-object))))
                    (response
                      (call-command
                       plane
                       (make-envelope
                        "melissa.request"
                        (quasar.protocol:json-object
                         (cons "entity" entity)
                         (cons "options" (quasar.protocol:json-object)))
                        :id request-id))))
               (check response)
               (check (string= "ok" (status response)))
               (check (search entity-id response)))
             (quasar.actors.melissa.bridge:stop-melissa-integration plane)
             (check
              (null
               (member "melissa.request"
                       (quasar.control-plane:control-plane-capabilities plane)
                       :test #'string=)))
             (check
              (null
               (member "melissa.status"
                       (quasar.control-plane:control-plane-capabilities plane)
                       :test #'string=)))))
      (ignore-errors
        (quasar.actors.melissa.bridge:stop-melissa-integration plane))
      (ignore-errors
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-melissa-restart-tests ()
  (test-melissa-stop-restart)
  t)
