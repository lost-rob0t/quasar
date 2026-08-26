(in-package #:quasar.tests)

(defvar *autodig-worker-reclaim-failures* 0)

(defmacro autodig-reclaim-check (form)
  `(unless ,form
     (incf *autodig-worker-reclaim-failures*)
     (format *error-output* "~&FAIL autodig-worker-reclaim: ~S~%" ',form)))

(defun test-expired-autodig-worker-lease-can-be-reclaimed ()
  (let ((plane (quasar.control-plane:make-control-plane)))
    (quasar.control-plane:start-control-plane plane)
    (unwind-protect
         (let* ((start (start-autodig-run plane
                                          "worker-restart-request"
                                          "restart-worker.example"
                                          "worker-restart-workspace"))
                (run-id (autodig-run-id start))
                (first-claim
                  (and run-id
                       (worker-autodig-command
                        plane "autodig.worker.claim" run-id
                        "worker-restart-workspace" "worker-a")))
                (first-result (autodig-ok-result first-claim))
                (first-lease
                  (and first-result
                       (jsown:val first-result "leaseId"))))
           (autodig-reclaim-check first-result)
           (autodig-reclaim-check
            (and first-lease (plusp (length first-lease))))

           ;; Sento executes the command on an actor thread, so a dynamic LET
           ;; binding in this test thread would not affect the handler. Change
           ;; the global timeout only for this guarded section, then restore it.
           (let ((original-timeout
                   quasar.control-plane::+autodig-worker-lease-timeout-seconds+))
             (unwind-protect
                  (progn
                    (setf quasar.control-plane::+autodig-worker-lease-timeout-seconds+ 0)
                    (let* ((replacement-claim
                             (and run-id
                                  (worker-autodig-command
                                   plane "autodig.worker.claim" run-id
                                   "worker-restart-workspace" "worker-b")))
                           (replacement-result
                             (autodig-ok-result replacement-claim))
                           (replacement-lease
                             (and replacement-result
                                  (jsown:val replacement-result "leaseId")))
                           (stale-heartbeat
                             (and first-lease
                                  (worker-autodig-command
                                   plane "autodig.worker.heartbeat" run-id
                                   "worker-restart-workspace" "worker-a"
                                   :lease-id first-lease))))
                      (autodig-reclaim-check replacement-result)
                      (when replacement-result
                        (autodig-reclaim-check
                         (string= (jsown:val replacement-result "runId") run-id))
                        (autodig-reclaim-check
                         (string= (jsown:val replacement-result "workerId")
                                  "worker-b")))
                      (autodig-reclaim-check
                       (and replacement-lease
                            (not (string= replacement-lease first-lease))))
                      (autodig-reclaim-check
                       (string= (status stale-heartbeat) "error"))
                      (autodig-reclaim-check
                       (and (string= (status stale-heartbeat) "error")
                            (string= (error-code stale-heartbeat)
                                     "autodig.stale-worker")))))
               (setf quasar.control-plane::+autodig-worker-lease-timeout-seconds+
                     original-timeout))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-autodig-worker-reclaim-tests ()
  (setf *autodig-worker-reclaim-failures* 0)
  (test-expired-autodig-worker-lease-can-be-reclaimed)
  (when (plusp *autodig-worker-reclaim-failures*)
    (error "~D Auto-Dig worker reclaim test(s) failed."
           *autodig-worker-reclaim-failures*))
  (format t "~&Auto-Dig worker reclaim tests passed.~%")
  t)
