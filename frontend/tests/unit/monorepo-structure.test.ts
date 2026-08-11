import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("monorepo structure", () => {
  it("has no .gitmodules file", () => {
    expect(existsSync(join(repoRoot, ".gitmodules"))).toBe(false);
  });

  it("has frontend/package.json as a tracked file", () => {
    const pkgPath = join(repoRoot, "frontend", "package.json");
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(pkg.name).toBe("quasar-ui");
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.build).toBeDefined();
  });

  it("has frontend/src/control-plane/index.ts", () => {
    expect(existsSync(join(repoRoot, "frontend", "src", "control-plane", "index.ts"))).toBe(true);
  });

  it("has control-plane/src/protocol.lisp", () => {
    expect(existsSync(join(repoRoot, "control-plane", "src", "protocol.lisp"))).toBe(true);
  });

  it("has systems/ directory with ASDF definitions", () => {
    expect(existsSync(join(repoRoot, "systems", "quasar-control.asd"))).toBe(true);
    expect(existsSync(join(repoRoot, "systems", "quasar-tests.asd"))).toBe(true);
  });

  it("frontend builds from tracked files (package-lock exists)", () => {
    expect(existsSync(join(repoRoot, "frontend", "package-lock.json"))).toBe(true);
  });
});
