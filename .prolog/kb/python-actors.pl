%% Durable Quasar knowledge: Python pro-actor self-run support.

%% Contract
python_actors(commands, 'python-actors.status (sync) lists configured checkout/python/actors; python-actors.run (async thread) runs one actor family via starintel-actor-run and ingests canonical JSONL into the workspace').
python_actors(run_path, 'python-actors.run builds a canonical target doc (dtype target, schema_version 0.9.0, dataset quasar-python-actors) and pipes it to: <python> -m starintel_pro_actors.actor_run_cli run <actor> --target <json>').
python_actors(ingest, 'emitted docs go through one workspace.transaction; per-id document.get probe routes existing ids to document.update so reruns update instead of duplicate').
python_actors(melissa_products, 'every Melissa DataSource service is selectable via options {service: X} or providers list; fields map via options.fields (e.g. {ip: 8.8.8.8} + service global-ip)').

%% Configuration
python_actors(env_checkout, 'QUASAR_PRO_ACTORS_PATH overrides the checkout; default ~/starintel/starintel-pro-actors; explicit-but-broken path is reported, never silently fallen back').
python_actors(env_python, 'QUASAR_PYTHON overrides interpreter; default prefers <checkout>/python/.venv/bin/python then python3').
python_actors(dotenv, 'the runner overlays the checkout gitignored .env (KEY=VALUE, # comments) onto the subprocess env plus PYTHONPATH=<checkout>/python/src; values never logged or returned').
python_actors(capabilities, 'python-actors.status/run added to quasar.ws +default-capabilities+; hosted entitlements derive capability lists explicitly so the initform only covers local sessions').

%% Test seams
python_actors(executor_seam, 'control-plane-python-actors-executor slot on the plane (NOT a special variable: dynamic bindings do not cross sento mailbox/worker threads); tests setf it to a fake returning canned JSONL').
python_actors(live_lane, 'QUASAR_PYTHON_ACTORS_LIVE=1 + QUASAR_PRO_ACTORS_PATH=<pro-actors worktree> drives the real Melissa API; hermetic CI skips it').
