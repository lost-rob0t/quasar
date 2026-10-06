(require :asdf)
(asdf:load-system :starintel-0101)
(asdf:load-system :jsown)
(load "control-plane/src/packages.lisp")
(load "control-plane/src/protocol.lisp")
(load "control-plane/src/starintel-contract.lisp")
(load "control-plane/src/workspace.lisp")
;; Load test function definitions only. This gate exercises real workspace/protocol
;; boundaries; storage/actor tests require the separate full dependency gate.
(let ((*package* (find-package :quasar.tests)))
  (with-open-file (stream "control-plane/tests/control-plane-tests.lisp")
    (loop for form = (read stream nil :eof) until (eq form :eof)
          when (member (first form) '(defun defmacro defvar defparameter)) do (eval form)))
  (load "control-plane/tests/workspace-integrity-tests.lisp"))
(setf quasar.tests::*failures* 0)
(dolist (name '(test-protocol-decode test-protocol-encode test-protocol-preserves-json-scalars
               test-clone-json test-workspace-revision test-graph-put-preserves-membership-null
               test-graph-put-accepts-jsown-string-array-document-ids test-document-crud
               test-document-not-found test-document-invalid test-node-crud test-node-not-found
               test-node-invalid-document-ref test-edge-crud test-edge-invalid-reference
               test-node-delete-removes-edges test-document-delete-blocked-by-graph
               test-duplicate-id-rejection test-transaction-rollback test-transaction-graph-isolation
               test-transaction-graph-rollback test-inverse-round-trip-document
               test-inverse-round-trip-node test-node-delete-inverse-restores-edges
               test-document-delete-membership-inverse test-inverse-round-trip-edge
               test-inverse-round-trip-update))
  (format t "Running ~A~%" name)
  (funcall (find-symbol (symbol-name name) :quasar.tests)))
(quasar.tests::run-workspace-integrity-tests)
(assert (zerop quasar.tests::*failures*))
(format t "27 protocol/workspace tests and workspace integrity suite passed.~%")
