# First run

## 1. Install

For a persistent command:

```sh
nix profile install github:lost-rob0t/quasar#end-user
quasar doctor
quasar install
```

## 2. Start

```sh
quasar up
quasar status
```

Open Quasar at:

```text
http://127.0.0.1:8080
```

The local StarIntel API is:

```text
http://127.0.0.1:5000
```

## 3. Connect Quasar to StarIntel

Retrieve the generated first-run password:

```sh
quasar admin-password
```

In the Quasar StarIntel connection settings use:

- server URL: `http://127.0.0.1:5000`
- username: `quasar`
- password: the generated password above

The password is exchanged for StarIntel's opaque API-key credential; do not put the generated password into a tracked project file.

## 4. Verify the backend independently

```sh
curl --fail http://127.0.0.1:5000/health
```

A healthy response proves the StarIntel HTTP process is alive. `quasar status` additionally shows the local service/container state.

## 5. Create a workspace

Use Quasar's normal workspace controls to create or select a workspace. Workspace documents and graph state are owned by Quasar's Common Lisp control plane and persisted through Tek9/LMDB.

## 6. Add or import intelligence

Start with a small StarIntel document or import file. Quasar validates documents before committing them to the authoritative workspace. When you explicitly synchronize with StarIntel, the server remains the durable backend for the remote intelligence corpus.

Next: [Documents and graphs](DOCUMENTS-AND-GRAPHS.md).
