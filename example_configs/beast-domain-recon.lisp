(fbp:define-network beast-domain-recon
    (:version "1"
     :kind :workflow
     :capabilities (:a2a-worker)
     :limits (:packets 250000 :bytes 268435456 :seconds 7200 :concurrency 4))
  (:component "request" "object/build"
              :config (:workflow "domain-recon"
                       :domain "example.org"
                       :scope :public-network-metadata))
  (:component "recon" "starintel.a2a/worker"
              :config (:worker "recon-domain"))
  (:component "normalize" "starintel.a2a/worker"
              :config (:worker "normalize-provenance"))
  (:component "verify" "starintel.a2a/worker"
              :config (:worker "corroborate-verify"))
  (:component "publish" "starintel.a2a/worker"
              :config (:worker "graph-index-publisher"))
  (:connect "request" "object" "recon" "task" :capacity 32)
  (:connect "recon" "result" "normalize" "task" :capacity 128)
  (:connect "normalize" "result" "verify" "task" :capacity 128)
  (:connect "verify" "result" "publish" "task" :capacity 128)
  (:iip :start "request" "trigger"))
