#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const requirements = [
  { label: "SQLite", pattern: /^libsqlite3\.so(?:\..+)?$/ },
  { label: "OpenSSL TLS", pattern: /^libssl\.so(?:\..+)?$/ },
  { label: "OpenSSL crypto", pattern: /^libcrypto\.so(?:\..+)?$/ },
  { label: "RabbitMQ C", pattern: /^librabbitmq\.so(?:\..+)?$/ },
  { label: "LMDB", pattern: /^liblmdb\.so(?:\..+)?$/ },
  { label: "libffi", pattern: /^libffi\.so(?:\..+)?$/ },
];

function visibleLibraryNames() {
  const names = new Set();

  for (const directory of (process.env.LD_LIBRARY_PATH ?? "").split(":").filter(Boolean)) {
    try {
      for (const entry of readdirSync(directory)) names.add(entry);
    } catch {
      // A stale or inaccessible LD_LIBRARY_PATH entry is not itself fatal.
    }
  }

  const ldconfig = spawnSync("ldconfig", ["-p"], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  if (ldconfig.status === 0) {
    for (const line of ldconfig.stdout.split("\n")) {
      const match = line.trim().match(/^([^\s]+)\s+/);
      if (match) names.add(match[1]);
    }
  }

  return names;
}

if (process.platform !== "linux") {
  console.log("[native-runtime] non-Linux host; shared-library preflight skipped");
  process.exit(0);
}

const names = visibleLibraryNames();
const missing = requirements.filter(
  ({ pattern }) => ![...names].some((name) => pattern.test(name)),
);

if (missing.length > 0) {
  console.error(
    `[native-runtime] missing required shared libraries: ${missing.map(({ label }) => label).join(", ")}`,
  );
  console.error("[native-runtime] Quasar cannot safely start the Common Lisp control plane.");
  console.error("[native-runtime] Preferred: run through `nix develop` (npm run dev auto-enters it when Nix is available).");
  console.error(
    "[native-runtime] Debian/Ubuntu: sudo apt-get install libffi-dev libssl-dev libsqlite3-dev librabbitmq-dev liblmdb-dev",
  );
  process.exit(1);
}

console.log(
  `[native-runtime] OK: ${requirements.map(({ label }) => label).join(", ")}`,
);
