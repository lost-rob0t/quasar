(fbp:define-network beast-auto-dig-research
    (:version "1"
     :kind :workflow
     :capabilities (:a2a-worker)
     :limits (:packets 500000 :bytes 536870912 :seconds 14400 :concurrency 8))
  (:component "request" "object/build"
              :config (:workflow "auto-dig-research"
                       :question "configure-me"
                       :review-ambiguous t
                       :checkpoint :resume))
  (:component "orchestrate" "starintel.a2a/worker"
              :config (:worker "beast-orchestrator"))
  (:component "preserve" "starintel.a2a/worker"
              :config (:worker "archive-preserve"))
  (:component "normalize" "starintel.a2a/worker"
              :config (:worker "normalize-provenance"))
  (:component "verify" "starintel.a2a/worker"
              :config (:worker "corroborate-verify"))
  (:component "publish" "starintel.a2a/worker"
              :config (:worker "graph-index-publisher"))
  (:connect "request" "object" "orchestrate" "task" :capacity 32)
  (:connect "orchestrate" "result" "preserve" "task" :capacity 128)
  (:connect "preserve" "result" "normalize" "task" :capacity 128)
  (:connect "normalize" "result" "verify" "task" :capacity 128)
  (:connect "verify" "result" "publish" "task" :capacity 128)
  (:iip :start "request" "trigger"))
