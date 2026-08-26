(in-package #:quasar.config)

;;; Quasar defaults to durable Auto-Dig lifecycle events in the existing
;;; Tek9/LMDB-backed journal store.
(setf *autodig-persistence-backend* :tek9
      *autodig-filesystem-path* nil)

;;; To persist Auto-Dig lifecycle events as ordinary local files instead:
;;; (setf *autodig-persistence-backend* :filesystem
;;;       *autodig-filesystem-path* #P"/var/lib/quasar/autodig/")
