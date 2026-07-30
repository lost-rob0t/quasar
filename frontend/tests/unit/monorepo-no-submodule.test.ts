import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("monorepo no-submodule assertion", () => {
  it("does not contain a .gitmodules file", () => {
    expect(existsSync(join(repoRoot, ".gitmodules"))).toBe(false);
  });

  it("does not contain a frontend-overlay directory", () => {
    expect(existsSync(join(repoRoot, "frontend-overlay"))).toBe(false);
  });

  it("does not contain scripts/prepare-frontend.sh", () => {
    expect(existsSync(join(repoRoot, "scripts", "prepare-frontend.sh"))).toBe(false);
  });

  it("frontend/src/app/main.tsx imports control-plane directly", () => {
    const mainPath = join(repoRoot, "frontend", "src", "app", "main.tsx");
    const content = readFileSync(mainPath, "utf-8");
    expect(content).toContain('from "../control-plane"');
    expect(content).toContain("initializeControlPlane");
  });

  it("frontend/src/control-plane/client.ts exists and exports createControlPlaneClient", () => {
    const clientPath = join(repoRoot, "frontend", "src", "control-plane", "client.ts");
    expect(existsSync(clientPath)).toBe(true);
    const content = readFileSync(clientPath, "utf-8");
    expect(content).toContain("export function createControlPlaneClient");
    expect(content).toContain("export function initializeControlPlane");
  });

  it("control-plane/src/protocol.lisp uses quasar.control.v1", () => {
    const protocolPath = join(repoRoot, "control-plane", "src", "protocol.lisp");
    const content = readFileSync(protocolPath, "utf-8");
    expect(content).toContain('"quasar.control.v1"');
  });

  it("control-plane/src/websocket-server.lisp exists", () => {
    expect(existsSync(join(repoRoot, "control-plane", "src", "websocket-server.lisp"))).toBe(true);
  });
});
