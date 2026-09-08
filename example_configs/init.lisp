(in-package #:quasar.config)

;;; Logging defaults: everything goes to stdout in the historical
;;; [quasar] timestamp level subsystem event key=value format, and no
;;; log files are created unless a durable sink is configured.
;;;
;;; (setf *log-sink* :stdout            ; :stdout | :stderr | :file | :off
;;;       *log-file-path* nil           ; :file default: $XDG_DATA_HOME/quasar/logs/quasar.log
;;;       *log-level* nil               ; NIL => $QUASAR_LOG_LEVEL => info under CI => debug
;;;       *log-file-format* :json       ; :json (one object per line) | :text
;;;       *log-immediate-flush* t)      ; flush each record before the call returns
;;;
;;; To run with a durable append-only JSON log file:
;;; (setf *log-sink* :file
;;;       *log-file-path* #P"/var/lib/quasar/logs/quasar.log")

;;; Quasar defaults to durable Auto-Dig lifecycle events in the existing
;;; Tek9/LMDB-backed journal store.
(setf *autodig-persistence-backend* :tek9
      *autodig-filesystem-path* nil)

;;; To persist Auto-Dig lifecycle events as ordinary local files instead:
;;; (setf *autodig-persistence-backend* :filesystem
;;;       *autodig-filesystem-path* #P"/var/lib/quasar/autodig/")
