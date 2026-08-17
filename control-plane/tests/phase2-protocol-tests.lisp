(in-package #:quasar.tests)

(defun phase2-protocol-chunk-response (plane session-id sequence operations &key (id "phase2-protocol"))
  (call-command
   plane
   (make-envelope
    "document.import.chunk"
    (quasar.protocol:json-object
     (cons "sessionId" session-id)
     (cons "sequence" sequence)
     (cons "operations" operations))
    :id id)))

(defun test-phase2-malformed-import-protocol ()
  (with-temporary-tek9-store (store path "phase2-protocol")
    (declare (ignore path))
    (let ((plane
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin)))
             (flet ((expect-error (response code)
                      (check (string= "error" (status response)))
                      (check (string= code (error-code response)))))
               (expect-error
                (call-command
                 plane
                 (make-envelope
                  "document.import.chunk"
                  (quasar.protocol:json-object
                   (cons "sequence" 0)
                   (cons "operations" (quasar.protocol:json-array)))
                  :id "missing-session"))
                "import.invalid-session")
               (expect-error
                (call-command
                 plane
                 (make-envelope
                  "document.import.chunk"
                  (quasar.protocol:json-object
                   (cons "sessionId" 42)
                   (cons "sequence" 0)
                   (cons "operations" (quasar.protocol:json-array)))
                  :id "non-string-session"))
                "import.invalid-session")
               (dolist (value '(-1 1.5d0))
                 (expect-error
                  (phase2-protocol-chunk-response
                   plane session-id value (quasar.protocol:json-array)
                   :id (format nil "bad-sequence-~A" value))
                  "import.invalid-sequence"))
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id (expt 2 100) (quasar.protocol:json-array)
                 :id "massive-sequence")
                "import.sequence-gap")
               (expect-error
                (call-command
                 plane
                 (make-envelope
                  "document.import.chunk"
                  (quasar.protocol:json-object
                   (cons "sessionId" session-id)
                   (cons "sequence" 0))
                  :id "missing-operations"))
                "protocol.invalid-envelope")
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id 0 (quasar.protocol:json-object)
                 :id "object-operations")
                "protocol.invalid-envelope")
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id 0
                 (quasar.protocol:json-array
                  (quasar.protocol:json-object
                   (cons "type" "document.delete")
                   (cons "payload"
                         (quasar.protocol:json-object (cons "id" "x")))))
                 :id "unsupported-operation")
                "import.invalid-operation")
               (expect-error
                (phase2-protocol-chunk-response
                 plane session-id 0
                 (quasar.protocol:json-array
                  (quasar.protocol:json-object
                   (cons "type" "document.create")
                   (cons "payload"
                         (quasar.protocol:json-object (cons "_id" "missing-dtype")))))
                 :id "missing-dtype")
                "document.invalid")
               (let ((oversized
                       (quasar.protocol:json-array
                        (quasar.protocol:json-object
                         (cons "type" "document.create")
                         (cons "payload"
                               (quasar.protocol:json-object
                                (cons "_id" "oversized")
                                (cons "dtype" "person")
                                (cons "data"
                                      (make-string
                                       (+ (* 1024 1024) 1024)
                                       :initial-element #\x))))))))
                 (expect-error
                  (phase2-protocol-chunk-response
                   plane session-id 0 oversized :id "oversized-chunk")
                  "import.chunk-too-large"))
               (let ((too-many
                       (apply
                        #'quasar.protocol:json-array
                        (loop repeat 1001
                              collect
                                (quasar.protocol:json-object
                                 (cons "type" "document.create")
                                 (cons "payload"
                                       (quasar.protocol:json-object
                                        (cons "_id" "unused")
                                        (cons "dtype" "person"))))))))
                 (expect-error
                  (phase2-protocol-chunk-response
                   plane session-id 0 too-many :id "too-many-operations")
                  "import.chunk-too-many-operations"))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun test-phase2-invalid-stage-does-not-become-canonical ()
  (with-temporary-tek9-store (store path "phase2-invalid-stage")
    (declare (ignore path))
    (let ((plane
            (quasar.control-plane:start-control-plane
             (quasar.control-plane:make-control-plane :store store))))
      (unwind-protect
           (let* ((begin (phase2-spec-begin plane))
                  (session-id (phase2-spec-session-id begin))
                  (bad
                    (phase2-protocol-chunk-response
                     plane
                     session-id
                     0
                     (quasar.protocol:json-array
                      (quasar.protocol:json-object
                       (cons "type" "document.create")
                       (cons "payload"
                             (quasar.protocol:json-object
                              (cons "_id" "never-canonical")))))
                     :id "invalid-stage-chunk")))
             (check (string= "error" (status bad)))
             (check (string= "document.invalid" (error-code bad)))
             (check (= 0 (quasar.store:direct-workspace-revision store "default")))
             (let ((get
                     (call-command
                      plane
                      (make-envelope
                       "document.get"
                       (quasar.protocol:json-object (cons "id" "never-canonical"))
                       :id "never-canonical-get"))))
               (check (string= "document.not-found" (error-code get)))))
        (quasar.control-plane:stop-control-plane plane)))))

(defun run-phase2-protocol-tests ()
  (let ((*failures* 0))
    (test-phase2-malformed-import-protocol)
    (test-phase2-invalid-stage-does-not-become-canonical)
    (when (plusp *failures*)
      (error "~D Phase 2 protocol tests failed." *failures*))
    t))