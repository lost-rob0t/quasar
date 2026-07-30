import { describe, expect, it } from "vitest";
import { MELISSA_ACTORS as LEGACY_MELISSA_ACTORS } from "./melissa-actor-pack";
import {
  MELISSA_ACTORS as RUNTIME_MELISSA_ACTORS,
  MELISSA_ACTOR_PACK_VERSION
} from "./melissa-actor-pack-runtime";
import { installMelissaActorPack } from "./melissa-actor-installation";

describe("Melissa actor installation", () => {
  it("replaces stale actors with the current runtime pack", () => {
    const legacyPersonator = LEGACY_MELISSA_ACTORS.find(
      (actor) => actor.service === "personator-search"
    );
    const runtimePersonator = RUNTIME_MELISSA_ACTORS.find(
      (actor) => actor.service === "personator-search"
    );
    const customActor = { id: "quasar.actor.custom-test", source: "() => ({ documents: [] })" };

    const installed = installMelissaActorPack({
      actors: [customActor, legacyPersonator],
      actorsEnabled: false,
      melissaActorPackVersion: 2
    });
    const installedPersonator = installed.actors.find(
      (actor) => actor.service === "personator-search"
    );

    expect(MELISSA_ACTOR_PACK_VERSION).toBe(6);
    expect(installed.melissaActorPackVersion).toBe(6);
    expect(installed.actorsEnabled).toBe(true);
    expect(installed.melissaActorPackInstalled).toBe(true);
    expect(installed.actors).toContain(customActor);
    expect(installedPersonator.manualOnly).toBe(true);
    expect(installedPersonator.source).toBe(runtimePersonator.source);
    expect(installedPersonator.source).not.toBe(legacyPersonator.source);
  });
});
