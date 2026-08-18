(in-package #:quasar.control-plane)

(defparameter *phase3-materialized-run-operation*
  (symbol-function 'run-operation))
(defparameter *phase3-materialized-handle-transaction*
  (symbol-function 'handle-transaction))

(defun run-operation (plane envelope operation)
  (if (quasar.store:streaming-store-p (control-plane-store plane))
      (run-record-operation plane envelope operation)
      (funcall *phase3-materialized-run-operation* plane envelope operation)))

(defun handle-transaction (plane payload envelope)
  (if (quasar.store:streaming-store-p (control-plane-store plane))
      (handle-record-transaction plane payload envelope)
      (funcall *phase3-materialized-handle-transaction* plane payload envelope)))
