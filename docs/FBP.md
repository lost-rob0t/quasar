# Quasar flow-based programming

Quasar FBP follows J. Paul Morrison's process-and-port model: long-lived black-box
components exchange owned information packets through named, bounded FIFO
connections. Initial information packets (IIPs) seed a graph. Connections provide
back-pressure. A graph is a workflow, automation, or actor system only by deployment
intent; all three use the same `quasar.fbp.v1` model and runtime.

The visual editor is a projection. Its source of truth is the canonical graph, and
saved graphs are ordinary `quasar.fbp.workflow` documents in the existing
workspace/Tek9 store (never a second browser database). The catalog comes from the
Common Lisp registry and StarIntel's contract projection. Local validation is only
fast UI feedback; Common Lisp validation remains authoritative.

The Lisp it emits is ordinary readable Common Lisp with no reader macros. Import is
data-only: Quasar binds `*read-eval*` to `nil` and accepts only
`DEFINE-NETWORK`, `:COMPONENT`, `:CONNECT`, and `:IIP` forms.

## A network

```lisp
(fbp:define-network target-refresh
    (:version "1"
     :kind :automation
     :enabled-at-login t
     :capabilities (:starintel-operation)
     :limits (:packets 100000 :bytes 67108864 :seconds 3600 :concurrency 4))
  (:component "target" "object/build"
              :config (:actor "domain-hunt" :target "example.org"))
  (:component "submit" "starintel.operation/targets.create"
              :config (:operation "targets.create"
                       :credential-reference "credential:starintel-api"))
  (:connect "target" "object" "submit" "target" :capacity 16)
  (:iip :start "target" "trigger"))
```

Credential references name a configured secret. Graphs, generated Lisp, service
units, profile blocks, logs, and dry-run output never contain API-key values.

## Define a trusted Lisp node

```lisp
(fbp:define-node normalize/domain
    (:label "Normalize domain"
     :category "Text"
     :inputs ((domain :schema (:type "string")))
     :outputs ((domain :schema (:type "string")))
     :capabilities ())
    (inputs context)
  (declare (ignore context))
  (let ((value (cdr (assoc "domain" inputs :test #'string=))))
    (list (cons "domain"
                (list (string-downcase (string-trim '(#\Space #\Tab) value)))))))
```

`DEFINE-NODE` is trusted operator code loaded through normal Common Lisp/ASDF
lifecycle. The browser never uploads arbitrary Lisp for evaluation. Untrusted
language nodes must use the `process/exec` service, which is deny-by-default and is
expected to run argv directly inside an OS sandbox with network, paths, time, memory,
and output explicitly bounded.

Capability declarations in a graph are requests, not grants. Host configuration
supplies immutable runtime grants and adapters. `:all` is forbidden, and the DSL has
no trusted-code switch.

## StarIntel nodes

Quasar fetches `client-manifest.json` and materializes each explicitly host-allowed
`fbp_nodes` descriptor as an exact `starintel.operation/OPERATION_ID` palette node.
Each descriptor is derived from StarIntel's
canonical `star.http.contract`: method, path, body/query/path schemas, scopes,
authority, responses, and idempotency are not duplicated in Quasar. Invocation uses
the normal authenticated API route, preserving tenant, quota, authorization,
observability, target lease/fencing, and idempotency behavior.

Targets are currently represented by `targets.create`. Actor and domain-server nodes
use the same descriptor interface and become remotely executable when their canonical
manifest/API operations are present. Quasar does not guess missing server contracts.

Set `STARINTEL_ENDPOINT`, list exact operation IDs in
`QUASAR_STARINTEL_ALLOWED_OPERATIONS`, and provide the referenced credential via
`QUASAR_CREDENTIAL_STARINTEL_API` (or `STARINTEL_API_KEY`). The optional
`STARINTEL_AUTH_HEADER` and `STARINTEL_AUTH_PREFIX` settings support deployments
whose canonical gateway uses a header other than `Authorization: Bearer`.

## Login automation and shell profiles

The editor's deployment action first renders a dry-run plan. Applying an enabled
automation writes the canonical graph and a hardened user unit, then runs
`systemctl --user daemon-reload` and enables `quasar-fbp@ID.service`. The unit runs
the packaged `quasar-server fbp-run --graph …` entry point; development builds must
set `QUASAR_FBP_EXECUTABLE` to a compatible absolute executable. The shell
profile installer writes one marked, idempotent block with endpoint and credential
references plus the exact operation allowlist. It never writes key values. `sh` and
`bash` profiles are supported. Remote endpoints must use HTTPS; plain HTTP is
accepted only for the exact loopback hosts `localhost`, `127.0.0.1`, and `::1`.
