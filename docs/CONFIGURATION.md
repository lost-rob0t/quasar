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
