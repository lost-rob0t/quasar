(in-package #:quasar.ws)

(pushnew "melissa.request" +default-capabilities+ :test #'string=)
(pushnew "melissa.status" +default-capabilities+ :test #'string=)
