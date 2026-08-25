(in-package #:quasar.control-plane)

(defun mutation-context-live-edge-reference-graphs (context document-id)
  "Return loaded overlay graphs that still contain an edge referencing DOCUMENT-ID.

Callers first hydrate the durable matching sidecars. Tombstoned edges are not
installed, while staged/new/replaced graph edges already live in the overlay,
so this scan observes base + staged state without materializing unrelated data."
  (loop
    for graph-id being the hash-keys
      of (quasar.workspace:workspace-graphs
          (mutation-context-workspace context))
    using (hash-value graph)
    when
      (find
       document-id
       (quasar.workspace:array-elements
        (quasar.workspace:graph-edges graph))
       :key (lambda (edge)
              (quasar.protocol:json-value edge "documentId"))
       :test #'string=)
      collect graph-id))

(defun mutation-context-require-no-live-edge-reference (context document-id)
  (let ((graph-ids
          (mutation-context-live-edge-reference-graphs context document-id)))
    (when graph-ids
      (error 'quasar.protocol:quasar-error
             :code "graph.invalid-reference"
             :message
             (format nil
                     "Document ~A is referenced by relation edges in ~{~A~^, ~}; remove or retarget those edges before deleting the document."
                     document-id graph-ids))))
  context)
