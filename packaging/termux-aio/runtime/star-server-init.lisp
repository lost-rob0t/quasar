(in-package :star)

;;; Quasar Termux AIO is a loopback-only, single-user appliance. Runtime
;;; secrets are generated at first bootstrap and injected by run-star-server.sh.
(setf *couchdb-host* "127.0.0.1"
      *couchdb-port* 5984
      *couchdb-scheme* "http"
      *couchdb-user* "admin"
      *couchdb-password* (or (uiop:getenv "COUCHDB_PASSWORD") "")
      *couchdb-default-database* "starintel"
      *couchdb-event-log-database* "starintel-event-source"

      *rabbit-address* "127.0.0.1"
      *rabbit-port* 5672
      *rabbit-user* "guest"
      *rabbit-password* "guest"

      *http-api-address* "127.0.0.1"
      *http-api-port* 5000
      *http-cors-allowed-origins*
      '("http://127.0.0.1:8080" "http://localhost:8080")

      *auth-pepper* (or (uiop:getenv "STAR_AUTH_PEPPER") "")
      *auth-initial-username* "star"
      *auth-initial-password*
      (or (uiop:getenv "STAR_AUTH_INITIAL_PASSWORD") "termux-local-only")
      *auth-dev-bypass* t
      *public-mode* t

      *lease-store-backend* "valkey"
      *valkey-lease-host* "127.0.0.1"
      *valkey-lease-port* 6379
      *valkey-lease-password-file* "/opt/quasar-aio/state/secrets/valkey-password"

      *ingest-workers* 2
      *bulk-max-documents* 250)

(setf star.actors:*publish-timeout-seconds* 5)

;;; Never export telemetry from a local phone appliance unless an operator
;;; deliberately replaces this trusted init file.
(setf (uiop:getenv "STAR_OBSERVABILITY_ENABLED") "false")
