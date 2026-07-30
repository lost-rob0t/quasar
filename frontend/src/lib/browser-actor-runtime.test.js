import { describe, expect, it } from "vitest";
import {
  BROWSER_ACTOR_RUNTIME,
  actorContextApplicability,
  browserActorManifestFromLegacy,
  buildBrowserActorWorkerSource,
  normalizeBrowserActorManifest,
  normalizeBrowserActorResult
} from "./browser-actor-runtime";

const source = `(context, actor) => ({
  documents: [],
  operations: [],
  message: actor.actor.id + ":" + context.selection.length
})`;

const manifest = {
  id: "test.browser-actor",
  label: "Test browser actor",
  version: 1,
  accepts: ["person"],
  minSelection: 1,
  maxSelection: 2,
  capabilities: ["documents.get", "events.emit", "documents.get"],
  source
};

describe("browser actor manifests", () => {
  it("normalizes capabilities, limits, and runtime", () => {
    const actor = normalizeBrowserActorManifest(manifest);
    expect(actor.runtime).toBe(BROWSER_ACTOR_RUNTIME);
    expect(actor.capabilities).toEqual(["documents.get", "events.emit"]);
    expect(actor.limits.timeoutMs).toBe(30_000);
  });

  it("denies unknown capabilities", () => {
    expect(() =>
      normalizeBrowserActorManifest({
        ...manifest,
        capabilities: ["pouchdb.raw"]
      })
    ).toThrow("Unsupported actor capability");
  });

  it("adapts existing Quasar actor manifests", () => {
    const actor = browserActorManifestFromLegacy({
      id: "legacy.actor",
      label: "Legacy",
      version: 1,
      accepts: ["*"],
      source: "() => ({ documents: [] })"
    });
    expect(actor.runtime).toBe(BROWSER_ACTOR_RUNTIME);
    expect(actor.capabilities).toEqual([]);
  });

  it("checks selection and accepted object types", () => {
    expect(actorContextApplicability(manifest, { selection: [] }).applicable).toBe(false);
    expect(actorContextApplicability(manifest, { selection: [{ dtype: "org" }] }).reason).toBe(
      "Does not accept org documents."
    );
    expect(
      actorContextApplicability(manifest, { selection: [{ dtype: "person" }] }).applicable
    ).toBe(true);
  });

  it("builds a parseable dedicated-worker program", () => {
    const workerSource = buildBrowserActorWorkerSource(manifest);
    expect(() => Function(workerSource)).not.toThrow();
    expect(workerSource).toContain("documents.get");
    expect(workerSource).toContain("Actor capability denied");
  });
});

describe("browser actor results", () => {
  it("normalizes the full result envelope", () => {
    expect(
      normalizeBrowserActorResult(
        {
          documents: [{ _id: "one" }],
          operations: [{ op: "remove_document", id: "two" }],
          artifacts: [{ name: "report.json" }],
          message: "done",
          metrics: { requests: 2 }
        },
        manifest
      )
    ).toEqual({
      documents: [{ _id: "one" }],
      operations: [{ op: "remove_document", id: "two" }],
      artifacts: [{ name: "report.json" }],
      message: "done",
      metrics: { requests: 2 }
    });
  });

  it("enforces manifest output limits", () => {
    const bounded = {
      ...manifest,
      limits: { maxDocuments: 1 }
    };
    expect(() => normalizeBrowserActorResult({ documents: [{}, {}] }, bounded)).toThrow(
      "more than 1 documents"
    );
  });
});
