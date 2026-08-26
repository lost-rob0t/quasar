(in-package #:quasar.tests)

(defvar *autodig-principal-isolation-failures* 0)

(defmacro autodig-principal-check (form)
  `(unless ,form
     (incf *autodig-principal-isolation-failures*)
     (format *error-output* "~&FAIL autodig-principal-isolation: ~S~%" ',form)))

(defun call-delegated-autodig-command (plane encoded principal)
  "Submit ENCODED as a server-authenticated delegated human principal.
Returns NIL when the current control-plane API cannot yet carry trusted
principal context; that is the intended RED state for this test slice."
  (let ((response nil))
    (handler-case
        (progn
          (quasar.control-plane:submit-command
           plane encoded
           (lambda (value) (setf response value))
           :principal principal
           :authority-kind :delegated-user)
          (loop until response
                for index below 1000
                do (sleep 0.01)
                finally (return response)))
      (error () nil))))

(defun delegated-autodig-start (plane principal request-id target workspace id)
  (call-delegated-autodig-command
   plane
   (make-envelope
    "autodig.run.start"
    (quasar.protocol:json-object
     (cons "requestId" request-id)
     (cons "target" target))
    :id id
    :workspace workspace)
   principal))

(defun delegated-autodig-get (plane principal run-id workspace id
                              &key spoofed-principal)
  (let ((encoded
          (if spoofed-principal
              (quasar.protocol:encode
               (quasar.protocol:json-object
                (cons "protocol" quasar.protocol:+protocol-version+)
                (cons "id" id)
                (cons "command" "autodig.run.get")
                (cons "payload"
                      (quasar.protocol:json-object (cons "runId" run-id)))
                (cons "metadata"
                      (quasar.protocol:json-object
                       (cons "client" "quasar-tests")
                       (cons "workspace" workspace)
                       (cons "principal" spoofed-principal)))))
              (make-envelope
               "autodig.run.get"
               (quasar.protocol:json-object (cons "runId" run-id))
               :id id
               :workspace workspace))))
    (call-delegated-autodig-command plane encoded principal)))

(defun delegated-autodig-list (plane principal workspace id)
  (call-delegated-autodig-command
   plane
   (make-envelope
    "autodig.run.list"
    (quasar.protocol:json-object (cons "limit" 20))
    :id id
    :workspace workspace)
   principal))

(defun delegated-autodig-status (plane principal workspace id)
  (call-delegated-autodig-command
   plane
   (make-envelope
    "autodig.status"
    (quasar.protocol:empty-object)
    :id id
    :workspace workspace)
   principal))

(defun delegated-autodig-transition
    (plane principal command run-id workspace id)
  (call-delegated-autodig-command
   plane
   (make-envelope
    command
    (quasar.protocol:json-object (cons "runId" run-id))
    :id id
    :workspace workspace)
   principal))

(defun response-ok-p (response)
  (and response (string= (status response) "ok")))

(defun response-error-code-is-p (response code)
  (and response
       (string= (status response) "error")
       (string= (error-code response) code)))

(defun test-delegated-users-isolate-runs-inside-one-workspace ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((workspace "shared-bixby-workspace")
                (user-a "starintel-human-a")
                (user-b "starintel-human-b")
                (start-a
                  (delegated-autodig-start
                   plane user-a "shared-visible-request" "alpha.example"
                   workspace "principal-start-a"))
                (run-a (and (response-ok-p start-a)
                            (autodig-run-id start-a)))
                (start-b
                  (delegated-autodig-start
                   plane user-b "shared-visible-request" "alpha.example"
                   workspace "principal-start-b"))
                (run-b (and (response-ok-p start-b)
                            (autodig-run-id start-b))))
           (autodig-principal-check (response-ok-p start-a))
           (autodig-principal-check (response-ok-p start-b))
           (autodig-principal-check
            (and run-a run-b (not (string= run-a run-b))))
           (when start-a
             (autodig-principal-check (not (search user-a start-a))))
           (when start-b
             (autodig-principal-check (not (search user-b start-b))))
           (when (and run-a run-b)
             (let* ((a-own (delegated-autodig-get
                            plane user-a run-a workspace "principal-a-own"))
                    (b-own (delegated-autodig-get
                            plane user-b run-b workspace "principal-b-own"))
                    (b-reads-a (delegated-autodig-get
                                plane user-b run-a workspace "principal-b-reads-a"))
                    (spoofed-b-reads-a
                      (delegated-autodig-get
                       plane user-b run-a workspace "principal-b-spoofs-a"
                       :spoofed-principal user-a))
                    (b-pauses-a
                      (delegated-autodig-transition
                       plane user-b "autodig.run.pause" run-a workspace
                       "principal-b-pauses-a"))
                    (a-list (delegated-autodig-list
                             plane user-a workspace "principal-a-list"))
                    (b-list (delegated-autodig-list
                             plane user-b workspace "principal-b-list"))
                    (a-status (delegated-autodig-status
                               plane user-a workspace "principal-a-status"))
                    (b-status (delegated-autodig-status
                               plane user-b workspace "principal-b-status")))
               (autodig-principal-check (response-ok-p a-own))
               (autodig-principal-check (response-ok-p b-own))
               (autodig-principal-check
                (response-error-code-is-p b-reads-a "autodig.run-not-found"))
               (autodig-principal-check
                (response-error-code-is-p spoofed-b-reads-a
                                          "autodig.run-not-found"))
               (autodig-principal-check
                (response-error-code-is-p b-pauses-a "autodig.run-not-found"))
               (autodig-principal-check
                (and (response-ok-p a-list)
                     (= (length (autodig-array-elements (result a-list))) 1)))
               (autodig-principal-check
                (and (response-ok-p b-list)
                     (= (length (autodig-array-elements (result b-list))) 1)))
               (autodig-principal-check
                (and (response-ok-p a-status)
                     (= (jsown:val (result a-status) "totalRuns") 1)))
               (autodig-principal-check
                (and (response-ok-p b-status)
                     (= (jsown:val (result b-status) "totalRuns") 1))))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-autodig-principal-isolation-tests ()
  (setf *autodig-principal-isolation-failures* 0)
  (test-delegated-users-isolate-runs-inside-one-workspace)
  (when (plusp *autodig-principal-isolation-failures*)
    (error "Auto-Dig principal-isolation tests failed: ~D"
           *autodig-principal-isolation-failures*))
  (format t "~&Auto-Dig principal-isolation tests passed.~%")
  t)