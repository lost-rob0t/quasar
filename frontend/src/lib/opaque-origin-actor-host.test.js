import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveMelissaConfig } from "./melissa-browser-config";
import {
  actorConfigurationForExecution,
  configureMelissaActorUrl
} from "./opaque-origin-actor-host";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

let previousStorage;

beforeEach(() => {
  previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage()
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousStorage
  });
});

describe("browser actor host configuration", () => {
  it("loads Melissa configuration and injects the exact credit key", () => {
    const actor = { id: "quasar.actor.melissa-runtime-test" };
    saveMelissaConfig({
      licenseKey: "CR+ED/IT==",
      transmissionReference: "Quasar credit test"
    });

    const configuration = actorConfigurationForExecution(actor, true);
    const url = configureMelissaActorUrl(
      new URL(
        "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch?last=Porter&format=JSON"
      ),
      actor,
      configuration,
      true
    );

    expect(configuration.transmissionReference).toBe("Quasar credit test");
    expect(url.searchParams.get("id")).toBe("CR+ED/IT==");
    expect(url.href).toContain("id=CR%2BED%2FIT%3D%3D");
  });

  it("does not expose shared Melissa credentials to untrusted actors", () => {
    const actor = { id: "quasar.actor.melissa-untrusted" };
    saveMelissaConfig({ licenseKey: "SECRET" });

    expect(actorConfigurationForExecution(actor, false)).toEqual({});
    const url = configureMelissaActorUrl(
      new URL("https://personatorsearch.melissadata.net/WEB/doPersonatorSearch?last=Porter"),
      actor,
      {},
      false
    );
    expect(url.searchParams.has("id")).toBe(false);
  });
});
