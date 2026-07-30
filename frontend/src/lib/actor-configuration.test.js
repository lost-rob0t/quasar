import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR_CONFIGURATION_STORAGE_KEY,
  actorConfigurationStatus,
  clearActorConfiguration,
  loadActorConfiguration,
  saveActorConfiguration
} from "./actor-configuration";
import { MELISSA_CONFIG_STORAGE_KEY } from "./melissa-browser-config";

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

describe("actor configuration", () => {
  it("stores arbitrary actor JSON by actor id", () => {
    const actor = { id: "quasar.actor.custom", label: "Custom" };
    saveActorConfiguration(actor, { endpoint: "https://example.test", retries: 3 });

    expect(loadActorConfiguration(actor)).toEqual({
      endpoint: "https://example.test",
      retries: 3
    });
    expect(localStorage.getItem(ACTOR_CONFIGURATION_STORAGE_KEY)).toContain("quasar.actor.custom");

    clearActorConfiguration(actor);
    expect(loadActorConfiguration(actor)).toEqual({});
  });

  it("shares Melissa configuration across every Melissa actor", () => {
    const first = { id: "quasar.actor.melissa-global-email" };
    const second = { id: "quasar.actor.melissa-property" };
    saveActorConfiguration(first, { licenseKey: "TEST-KEY", defaultCountry: "ca" });

    expect(loadActorConfiguration(second)).toMatchObject({
      licenseKey: "TEST-KEY",
      defaultCountry: "CA"
    });
    expect(localStorage.getItem(MELISSA_CONFIG_STORAGE_KEY)).toContain("TEST-KEY");
    expect(actorConfigurationStatus(second)).toMatchObject({ configured: true, missing: [] });
  });

  it("reports the missing Melissa license key", () => {
    expect(actorConfigurationStatus({ id: "quasar.actor.melissa-global-ip" })).toMatchObject({
      configured: false,
      missing: ["License Key Using Credits or subscription license key"]
    });
  });
});
