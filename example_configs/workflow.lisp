(fbp:define-network hello-flow
    (:version "1" :kind :workflow :capabilities ())
  (:component "copy" "core/identity")
  (:component "sink" "core/identity")
  (:connect "copy" "out" "sink" "in" :capacity 8)
  (:iip "hello from Quasar FBP" "copy" "in"))

