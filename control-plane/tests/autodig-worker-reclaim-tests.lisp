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
                (first-lease
                  (and (autodig-ok-result first-claim)
                       (jsown:val (result first-claim) "leaseId"))))
           (autodig-reclaim-check (string= (status first-claim) "ok"))
           (autodig-reclaim-check
            (and first-lease (plusp (length first-lease))))

           ;; A live lease remains exclusive, but once its owning heartbeat is
           ;; expired a replacement scheduled worker must be able to reclaim
           ;; the durable run without user intervention or a second run ID.
           (let* ((quasar.control-plane::+autodig-worker-lease-timeout-seconds+ 0)
                  (replacement-claim
                    (and run-id
                         (worker-autodig-command
                          plane "autodig.worker.claim" run-id
                          "worker-restart-workspace" "worker-b")))
                  (replacement-lease
                    (and (autodig-ok-result replacement-claim)
                         (jsown:val (result replacement-claim) "leaseId")))
                  (stale-heartbeat
                    (and first-lease
                         (worker-autodig-command
                          plane "autodig.worker.heartbeat" run-id
                          "worker-restart-workspace" "worker-a"
                          :lease-id first-lease))))
             (autodig-reclaim-check
              (string= (status replacement-claim) "ok"))
             (autodig-reclaim-check
              (string= (jsown:val (result replacement-claim) "runId") run-id))
             (autodig-reclaim-check
              (string= (jsown:val (result replacement-claim) "workerId")
                       "worker-b"))
             (autodig-reclaim-check
              (and replacement-lease
                   (not (string= replacement-lease first-lease))))
             (autodig-reclaim-check
              (string= (status stale-heartbeat) "error"))
             (autodig-reclaim-check
              (string= (error-code stale-heartbeat) "autodig.stale-worker"))))
      (quasar.control-plane:stop-control-plane plane))))

(defun run-autodig-worker-reclaim-tests ()
  (setf *autodig-worker-reclaim-failures* 0)
  (test-expired-autodig-worker-lease-can-be-reclaimed)
  (when (plusp *autodig-worker-reclaim-failures*)
    (error "~D Auto-Dig worker reclaim test(s) failed."
           *autodig-worker-reclaim-failures*))
  (format t "~&Auto-Dig worker reclaim tests passed.~%")
  t)
