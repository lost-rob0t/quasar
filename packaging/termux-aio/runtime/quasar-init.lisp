(in-package #:quasar.config)

;;; Keep the canonical Quasar workspace durable in Tek9/LMDB inside the AIO
;;; bind-mounted state directory. Auto-Dig lifecycle state shares that durable
;;; journal rather than creating another database.
(setf *autodig-persistence-backend* :tek9
      *autodig-filesystem-path* nil)
