(in-package #:quasar.tests)

(defun assert-restarted-workspace (store plane expected-revision)
  "Preserve Phase 1 restart coverage while asserting the Phase 2 read boundary.
The protocol snapshot must not populate CONTROL-PLANE-WORKSPACES. Full restore
is exercised explicitly through LOAD-WORKSPACE, because that API remains the
compatibility path used by ordinary mutation code until #24's final phase."
  (let* ((response
           (call-command
            plane
            (make-envelope
             "workspace.snapshot"
             (quasar.protocol:json-object
              (cons "documentOffset" 0)
              (cons "documentByteLimit" (* 512 1024)))
             :id "restart-snapshot")))
         (snapshot (result response)))
    (check (string= "ok" (status response)))
    (check (= expected-revision
              (quasar.protocol:json-value snapshot "revision")))
    (check (= 0
              (hash-table-count
               (quasar.control-plane:control-plane-workspaces plane))))
    (let* ((workspace (quasar.store:load-workspace store "default"))
           (graph (workspace-graph workspace "case")))
      (check workspace)
      (check (= expected-revision (workspace-revision workspace)))
      (check (gethash "person:1" (workspace-documents workspace)))
      (check (string= "relation"
                      (quasar.protocol:json-value
                       (gethash "relation:1" (workspace-documents workspace))
                       "dtype")))
      (check (gethash "person:2" (workspace-documents workspace)))
      (check graph)
      (check (graph-node graph "n1"))
      (check (graph-node graph "n3"))
      (check (graph-edge graph "edge:1"))
      (check (graph-edge graph "edge:2"))
      (check (string= "canonical edge metadata"
                      (quasar.protocol:json-value
                       (graph-edge graph "edge:1") "label")))
      (check (string= "relation:1"
                      (quasar.protocol:json-value
                       (graph-edge graph "edge:1") "documentId")))
      (check (equal "preset"
                    (quasar.protocol:json-value graph "layout")))
      (check (quasar.protocol:json-value graph "viewport"))
      (check (quasar.protocol:json-value graph "positions"))
      (check (quasar.protocol:json-value graph "groups"))
      (check (string= "case"
                      (gethash "activeGraphId"
                               (workspace-settings workspace))))
      (check (= expected-revision
                (length
                 (quasar.store:store-journal-entries store "default"))))
      (check snapshot))))