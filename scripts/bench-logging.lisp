;;; Logging performance harness for quasar.log.
;;; Run via scripts/bench-logging. Reports per-event microseconds and
;;; bytes allocated for the default and durable sink configurations.

(load "~/quicklisp/setup.lisp")

(setf (uiop:getenv "CL_SOURCE_REGISTRY")
      (format nil "(:source-registry (:tree \"~A/systems/\") (:tree \"~A/starintel/tek9/\") (:tree \"~A/quicklisp/dists/quicklisp/software/\") :ignore-inherited-configuration)"
              (uiop:getenv "QUASAR_WORKTREE") (uiop:getenv "HOME") (uiop:getenv "HOME")))

(asdf:clear-configuration)
(asdf:load-asd (truename "systems/quasar-control.asd"))
(asdf:load-system :quasar-control)

(defpackage #:quasar.bench-logging
  (:use #:cl))

(in-package #:quasar.bench-logging)

(defparameter +iterations+ 20000)

(defun bytes-consed ()
  #+sbcl (sb-ext:get-bytes-consed)
  #-sbcl 0)

(defun run-benchmark (name thunk)
  (sb-ext:gc :full t)
  (funcall thunk)                       ; warm up code paths
  (sb-ext:gc :full t)
  (let* ((start-bytes (bytes-consed))
         (start (get-internal-run-time))
         (end (progn (loop repeat +iterations+ do (funcall thunk))
                     (get-internal-run-time)))
         (end-bytes (bytes-consed))
         (elapsed (/ (- end start) (float internal-time-units-per-second)))
         (per-event (/ (* elapsed 1.0d6) +iterations+))
         (bytes-per-event (/ (- end-bytes start-bytes) +iterations+)))
    (format t "~&  ~A: ~A events, ~,2F us/event, ~,1F bytes/event~%"
            name +iterations+ per-event bytes-per-event)))

(defun devnull-stream ()
  (open "/dev/null" :direction :output :if-exists :supersede))

(format t "~&Quasar logging benchmark (~A iterations per scenario)~%"
        +iterations+)

;;; 1. Default stdout text sink (emulation of `npm run dev` output).
(let ((null-stream (devnull-stream)))
  ;; The appender captures the stream at configuration time, so the
  ;; redirect must be in effect only for configuration and measurement.
  (let ((*standard-output* null-stream))
    (quasar.log:apply-config :sink :stdout :level :debug))
  (run-benchmark
   "stdout text sink (debug level)"
   (lambda ()
     (quasar.log:log-event
      :debug "control-plane" "command.received"
      :request-id "bench-req" :command "document.get"
      :workspace "default" :client "bench"
      :async nil)))
  (quasar.log:shutdown-logging)
  (close null-stream))

;;; 2. Durable JSON file sink with immediate flush (default policy).
(let ((path "/tmp/opencode/quasar-bench-immediate.log"))
  (ignore-errors (delete-file path))
  (quasar.log:apply-config :sink :file :file-path path
                           :file-format :json :immediate-flush t)
  (run-benchmark
   "file json sink (immediate flush)"
   (lambda ()
     (quasar.log:log-event
      :info "workspace" "operation.begin"
      :workspace "default" :revision 42 :index 1
      :type "document.update" :id "document:bench")))
  (quasar.log:shutdown-logging))

;;; 3. Durable JSON file sink with relaxed flush policy.
(let ((path "/tmp/opencode/quasar-bench-relaxed.log"))
  (ignore-errors (delete-file path))
  (quasar.log:apply-config :sink :file :file-path path
                           :file-format :json :immediate-flush nil)
  (run-benchmark
   "file json sink (interval flush)"
   (lambda ()
     (quasar.log:log-event
      :info "workspace" "operation.applied"
      :workspace "default" :index 1 :type "document.update")))
  (quasar.log:flush-logs)
  (quasar.log:shutdown-logging))

;;; 4. Level-filtered path: cost of events below the configured level.
(quasar.log:apply-config :sink :off :level :error)
(run-benchmark
 "filtered events (debug event at error level)"
 (lambda ()
   (quasar.log:log-event
    :debug "control-plane" "command.ok"
    :request-id "bench-req" :command "document.get"
    :workspace "default")))

(quasar.log:shutdown-logging)
(quasar.config:reset-config)
(format t "~&Benchmark complete.~%")
(force-output)
