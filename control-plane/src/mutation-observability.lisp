(in-package #:quasar.control-plane)

(defparameter *mutation-working-set-observer* nil
  "Optional test/diagnostic callback receiving bounded mutation working-set metrics.")

(defun mutation-context-working-set-metrics (context)
  (let* ((documents
           (hash-table-count (mutation-context-document-state context)))
         (graphs
           (hash-table-count (mutation-context-graph-state context)))
         (nodes
           (hash-table-count (mutation-context-node-state context)))
         (edges
           (hash-table-count (mutation-context-edge-state context)))
         (total (+ documents graphs nodes edges)))
    (quasar.protocol:json-object
     (cons "documents" documents)
     (cons "graphs" graphs)
     (cons "nodes" nodes)
     (cons "edges" edges)
     (cons "records" total))))

(defun observe-mutation-working-set (context)
  (let ((metrics (mutation-context-working-set-metrics context)))
    (when *mutation-working-set-observer*
      (funcall *mutation-working-set-observer* metrics))
    metrics))
