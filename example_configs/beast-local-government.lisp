(fbp:define-network beast-local-government
    (:version "1"
     :kind :workflow
     :capabilities (:a2a-worker)
     :limits (:packets 1000000 :bytes 536870912 :seconds 21600 :concurrency 8))
  (:component "request" "object/build"
              :config (:workflow "local-government-mirror"
                       :jurisdiction "configure-me"
                       :checkpoint :resume))
  (:component "catalog" "starintel.a2a/worker"
              :config (:worker "gov-catalog"))
  (:component "harvest" "starintel.a2a/worker"
              :config (:worker "gov-harvester"))
  (:component "preserve" "starintel.a2a/worker"
              :config (:worker "archive-preserve"))
  (:component "normalize" "starintel.a2a/worker"
              :config (:worker "normalize-provenance"))
  (:component "verify" "starintel.a2a/worker"
              :config (:worker "corroborate-verify"))
  (:component "publish" "starintel.a2a/worker"
              :config (:worker "graph-index-publisher"))
  (:connect "request" "object" "catalog" "task" :capacity 32)
  (:connect "catalog" "result" "harvest" "task" :capacity 128)
  (:connect "harvest" "result" "preserve" "task" :capacity 256)
  (:connect "preserve" "result" "normalize" "task" :capacity 256)
  (:connect "normalize" "result" "verify" "task" :capacity 256)
  (:connect "verify" "result" "publish" "task" :capacity 256)
  (:iip :start "request" "trigger"))
