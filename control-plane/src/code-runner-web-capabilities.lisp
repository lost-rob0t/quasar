(in-package #:quasar.ws)

(eval-when (:load-toplevel :execute)
  (when (let ((runner (uiop:getenv "QUASAR_CODE_RUNNER_BIN")))
          (and runner (plusp (length runner))))
    (pushnew "code.run" +default-capabilities+ :test #'string=)))
