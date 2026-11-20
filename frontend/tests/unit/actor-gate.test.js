import { describe, expect, it } from "vitest";
import {
  BUILTIN_ACTORS,
  actorE2eVerified,
  actorExecutionBlocked,
  normalizeActorManifest
} from "../../src/lib/actors";

const verifiedBuiltin = normalizeActorManifest(
  BUILTIN_ACTORS.find((actor) => actor.id === "quasar.actor.target-input-expansion")
);
const unverifiedBuiltin = normalizeActorManifest(
  BUILTIN_ACTORS.find((actor) => actor.id === "quasar.actor.normalize-names")
);
const customActor = normalizeActorManifest({
  id: "quasar.actor.custom-test",
  label: "Custom test actor",
  description: "Test actor",
  source: "(context) => ({ documents: [], message: 'ok' })"
});

describe("actorE2eVerified", () => {
  it("marks e2e-verified builtins as verified", () => {
    expect(actorE2eVerified(verifiedBuiltin)).toBe(true);
  });

  it("marks other builtins as not verified", () => {
    expect(actorE2eVerified(unverifiedBuiltin)).toBe(false);
    expect(actorE2eVerified(customActor)).toBe(false);
    expect(actorE2eVerified(null)).toBe(false);
  });
});

describe("actorExecutionBlocked", () => {
  it("allows e2e-verified builtins regardless of settings", () => {
    expect(actorExecutionBlocked(verifiedBuiltin, {})).toBe(false);
    expect(actorExecutionBlocked(verifiedBuiltin, { enableExperimentalActors: false })).toBe(false);
  });

  it("blocks non-verified builtins without the experimental opt-in", () => {
    expect(actorExecutionBlocked(unverifiedBuiltin, {})).toBe(true);
    expect(actorExecutionBlocked(unverifiedBuiltin, { enableExperimentalActors: false })).toBe(
      true
    );
  });

  it("allows non-verified builtins once experimental actors are enabled", () => {
    expect(actorExecutionBlocked(unverifiedBuiltin, { enableExperimentalActors: true })).toBe(
      false
    );
  });

  it("follows actorsEnabled for custom actors", () => {
    expect(actorExecutionBlocked(customActor, {})).toBe(true);
    expect(actorExecutionBlocked(customActor, { actorsEnabled: false })).toBe(true);
    expect(actorExecutionBlocked(customActor, { actorsEnabled: true })).toBe(false);
  });
});
