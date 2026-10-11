import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";

// A flake input is an exported source tree, not a mutable Git checkout. Prove
// both its expected revision and complete NAR contents before bootstrap uses it.
try {
  const [source, expectedRev] = process.argv.slice(2);
  if (!source || !/^[0-9a-f]{40}$/.test(expectedRev ?? "")) {
    throw new Error("Expected a Tek9 source path and full pinned revision");
  }
  const lock = JSON.parse(readFileSync(new URL("../flake.lock", import.meta.url), "utf8"));
  const input = lock.nodes?.[lock.root]?.inputs?.tek9;
  if (typeof input !== "string" || !lock.nodes?.[input]?.locked) {
    throw new Error("Missing direct locked Tek9 input in flake.lock");
  }
  const { rev, narHash } = lock.nodes[input].locked;
  if (rev !== expectedRev) {
    throw new Error(`Tek9 lock revision ${rev} differs from bootstrap pin ${expectedRev}`);
  }
  if (typeof narHash !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(narHash)) {
    throw new Error("Tek9 lock must contain a complete SHA-256 NAR hash");
  }
  const path = realpathSync(source);
  if (!statSync(path).isDirectory()) throw new Error("Tek9 source must be a directory");
  const result = spawnSync("nix", ["hash", "path", "--type", "sha256", "--sri", path], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Nix hash failed: ${result.error?.message ?? result.stderr.trim() ?? result.status}`);
  }
  const actual = result.stdout.trim();
  if (actual !== narHash) {
    throw new Error(`Tek9 source hash mismatch: expected ${narHash}, got ${actual || "empty output"}`);
  }
  console.log(`Verified Tek9 source ${rev} (${narHash}): ${path}`);
} catch (error) {
  console.error(`Cannot verify pinned Tek9 source: ${error.message}`);
  process.exit(1);
}
