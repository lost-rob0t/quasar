(in-package #:quasar.tests)

(defun pro-actor-test-manifest (&optional (actor "melissa")
                                  (repository "lost-rob0t/starintel-pro-actors"))
  (quasar.protocol:json-object
   (cons "_id" (format nil "starintel:actor-manifest:~A" actor))
   (cons "dtype" "actor-manifest")
   (cons "data"
         (quasar.protocol:json-object
          (cons "actor" actor)
          (cons "target_options" (quasar.protocol:json-array))))
   (cons "extensions"
         (quasar.protocol:json-object
          (cons "starintel.actor_manifest.v1"
                (quasar.protocol:json-object
                 (cons "actor_id" actor)
                 (cons "actor_type" "enricher")
                 (cons "implementation"
                       (quasar.protocol:json-object
                        (cons "repository" repository)
                        (cons "version" "test")))
                 (cons "configuration_schema" (quasar.protocol:empty-object))))))))

(defun pro-actor-test-target (actor)
  (quasar.protocol:json-object
   (cons "_id" (format nil "target:test:~A" actor))
   (cons "dtype" "target")
   (cons "data"
         (quasar.protocol:json-object
          (cons "actor" actor)
          (cons "target" "Ada Lovelace")
          (cons "target_type" "person")
          (cons "options" (quasar.protocol:json-array))))))

(defun seed-pro-actor-document (plane document)
  (let ((response
          (call-command
           plane
           (make-envelope
            "document.create"
            document
            :workspace "pro-actors"))))
    (check (string= (status response) "ok"))))

(defun test-pro-actor-manifest-discovery-and-target-gate ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-pro-actor-commands plane)
           (seed-pro-actor-document plane (pro-actor-test-manifest))
           (seed-pro-actor-document
            plane
            (pro-actor-test-manifest "foreign" "someone/else"))

           (let* ((response
                    (call-command
                     plane
                     (make-envelope
                      "pro-actors.manifests"
                      (quasar.protocol:empty-object)
                      :workspace "pro-actors")))
                  (documents (array-elements-for-test (result response))))
             (check (string= (status response) "ok"))
             (check (= 1 (length documents)))
             (check (string=
                     (quasar.protocol:json-value (first documents) "_id")
                     "starintel:actor-manifest:melissa")))

           (let* ((response
                    (call-command
                     plane
                     (make-envelope
                      "pro-actors.submit-target"
                      (quasar.protocol:json-object
                       (cons "target" (pro-actor-test-target "melissa")))
                      :workspace "pro-actors")))
                  (receipt (result response)))
             (check (string= (status response) "ok"))
             (check (eq :true (quasar.protocol:json-value receipt "authorized")))
             (check (string= (quasar.protocol:json-value receipt "actor") "melissa")))

           (let ((response
                   (call-command
                    plane
                    (make-envelope
                     "pro-actors.submit-target"
                     (quasar.protocol:json-object
                      (cons "target" (pro-actor-test-target "not-installed")))
                     :workspace "pro-actors"))))
             (check (string= (status response) "error"))
             (check (string= (error-code response) "pro-actors.manifest-missing"))))
      (quasar.control-plane:stop-control-plane plane))))

(defun test-pro-actor-invalid-target-is_rejected ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (unwind-protect
         (progn
           (quasar.control-plane:start-control-plane plane)
           (quasar.control-plane::install-pro-actor-commands plane)
           (let ((response
                   (call-command
                    plane
                    (make-envelope
                     "pro-actors.submit-target"
                     (quasar.protocol:json-object
                      (cons "target"
                            (quasar.protocol:json-object
                             (cons "_id" "bad")
                             (cons "dtype" "person"))))
                     :workspace "pro-actors"))))
             (check (string= (status response) "error"))
             (check (string= (error-code response) "pro-actors.invalid-target"))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-pro-actor-tests ()
  (test-pro-actor-manifest-discovery-and-target-gate)
  (test-pro-actor-invalid-target-is_rejected)
  t)
