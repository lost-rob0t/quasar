(in-package #:quasar.control-plane)

(defun install-geo-commands (plane)
  (dolist (entry (list (cons "geo.viewport" #'quasar.store:geo-viewport)
                      (cons "geo.points" #'quasar.store:geo-points)
                      (cons "geo.related" #'quasar.store:geo-related)
                      (cons "geo.resolve" #'quasar.store:geo-resolve)))
    (let ((function (cdr entry)))
      (register-command plane (car entry)
                        (lambda (payload envelope)
                          (bounded-wire-result
                           (funcall function (control-plane-store plane) (phase2-workspace-id envelope) payload)
                           envelope quasar.store::*query-max-bytes*)))))
  plane)
