(in-package #:quasar.protocol)

(dolist (code '("import.invalid-sequence"
                "import.chunk-conflict"
                "import.sequence-gap"
                "import.chunk-too-large"
                "import.chunk-too-many-operations"
                "storage.unsupported-schema"))
  (pushnew code +error-codes+ :test #'string=))