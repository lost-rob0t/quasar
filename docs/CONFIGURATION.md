# Quasar configuration

Quasar loads an executable Common Lisp init file before constructing the production control plane and its persistence adapters.

## Init file selection

Resolution order:

1. `--init PATH` or `-i PATH` passed to `quasar-server` / `scripts/run-production`;
2. `QUASAR_INIT_FILE`;
3. `$XDG_CONFIG_HOME/quasar/init.lisp`;
4. `~/.config/quasar/init.lisp` when `XDG_CONFIG_HOME` is unset.

A missing selected file is created from `example_configs/init.lisp` and then loaded. Syntax/runtime errors abort startup; Quasar does not silently ignore invalid configuration.

The init file is executable Common Lisp with the privileges of the Quasar process. Do not put committed secrets in it.

## Logging

Quasar logs through a single facility (`quasar.log`) built on log4cl. Every record carries a UTC timestamp, severity level, subsystem, event name, a human-readable message where appropriate, and structured key/value context (request ID, workspace ID, condition details, and arbitrary fields).

### Default behavior

Without any logging statements in the init file, all logs go to **stdout** in the historical `[quasar] ISO8601Z LEVEL subsystem event key=value` format:

```
[quasar] 2026-09-08T08:00:01Z DEBUG control-plane command.received REQUEST-ID="req-1" COMMAND="document.get" WORKSPACE="default"
```

`npm run dev` therefore shows server logs in the terminal naturally, and systemd/container deployments capture them with default `StandardOutput`/`docker logs` configuration. No log files are created merely because Quasar started.

### Init-file surface

```lisp
(in-package #:quasar.config)

;; Defaults (any variable you omit keeps its default):
(setf *log-sink* :stdout             ; :stdout | :stderr | :file | :off
      *log-file-path* nil            ; required name for :file; NIL => $XDG_DATA_HOME/quasar/logs/quasar.log
      *log-level* nil                ; NIL => $QUASAR_LOG_LEVEL => info when CI => debug
      *log-file-format* :json        ; file sink records: :json (one JSON object per line) | :text
      *log-immediate-flush* t)       ; flush every record to the OS before the log call returns
```

An explicit `*log-level*` in the init file wins over the environment. Levels are `debug`, `info`, `warn`, `error`, `fatal`, and `off`. Unknown levels, sinks, or formats, and `:file` with an empty path, are configuration errors: startup aborts with a clear message instead of falling back silently.

### Durable file sink

```lisp
(in-package #:quasar.config)

(setf *log-sink* :file
      *log-file-path* #P"/var/lib/quasar/logs/quasar.log")
```

Persistence guarantees:

- The file is opened **append-only**, so restarting Quasar preserves prior records and resumes cleanly.
- With the default `*log-immediate-flush* t`, every record is flushed to the operating system before the logging call returns; an abrupt `SIGKILL` loses at most the record being written. Set it to `nil` for higher throughput on busy deployments; buffered records are then flushed periodically and on shutdown.
- Every record is written under the sink's internal lock as one complete line, so concurrent Sento actor threads never produce interleaved or corrupt records.
- JSON-lines output (`*log-file-format* :json`) is one parseable object per line with `timestamp`, `level`, `subsystem`, `event`, `message`, `fields`, and `request_id`/`workspace_id` when available, suitable for `journalctl`-free ingestion pipelines.
- Shutdown (`SIGINT`/`SIGTERM`) flushes and closes the sink before the process exits.
- Sink failures are contained: a failing sink is reported and detached rather than crashing Quasar or interrupting actor work.
- Daily rotation is available through log4cl's daily file appender if a deployment needs it; it is not configured by default.

### Operational recommendations

- **systemd**: keep the default stdout sink; journald captures and persists it. Optionally rate-limit with `LogRateLimitIntervalSec` when running at `debug`.
- **Containers**: keep stdout (or set `:stderr`) so the runtime log collector owns files, retention, and rotation.
- **Bare-metal hosts without a supervisor**: use `:file` under `/var/lib/quasar/logs/` (or leave `*log-file-path*` `NIL` for `$XDG_DATA_HOME/quasar/logs/quasar.log`) and add logrotate if retention matters.
- Production deployments should set `QUASAR_LOG_LEVEL=info` (or `*log-level* :info` in the init file); `debug` includes per-operation workspace events and is meant for development.
- `npm run bench:logging` measures per-event latency and allocation per sink and flush policy; run it before and after changes that touch logging or dispatch hot paths.

## Auto-Dig persistence

The default is the existing Tek9/LMDB-backed Quasar journal:

```lisp
(in-package #:quasar.config)

(setf *autodig-persistence-backend* :tek9)
```

This preserves the existing Auto-Dig lifecycle storage under the Quasar workspace store and requires no new configuration.

To persist Auto-Dig lifecycle events as local files instead:

```lisp
(in-package #:quasar.config)

(setf *autodig-persistence-backend* :filesystem
      *autodig-filesystem-path* #P"/var/lib/quasar/autodig/")
```

If `*autodig-filesystem-path*` is `NIL`, the filesystem backend uses:

- `$XDG_DATA_HOME/quasar/autodig/`, or
- `~/.local/share/quasar/autodig/` when `XDG_DATA_HOME` is unset.

The filesystem adapter stores only Auto-Dig lifecycle events. It does not replace Tek9 as Quasar's canonical workspace/document/graph store. Workspace identifiers are converted to fixed derived filenames and are never used as literal path components. Updates are published by replacing a complete temporary file, so a partial temporary write is never treated as authoritative state. Malformed authoritative files fail closed at read time.

Both backends preserve the same Auto-Dig semantics: durable run IDs, request-id replay/conflict behavior, status/get/list, lifecycle transitions, and worker lease/fencing state across process restart.
