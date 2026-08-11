import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteProviderSecret,
  getProviderSecret,
  hasProviderSecret,
  setProviderSecret
} from "./agent-secrets";

function memoryStorage() {
  const values = new Map();
  return {
    clear: () => values.clear(),
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  };
}

describe("agent secrets", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage()
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: memoryStorage()
    });
    for (const id of ["openrouter", "openai", "anthropic"]) deleteProviderSecret(id);
  });

  it("stores provider keys only for the browser session", () => {
    const provider = {
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1"
    };
    setProviderSecret("openrouter", "secret-value", provider);

    const stored = JSON.parse(sessionStorage.getItem("quasar:provider-secret:openrouter"));
    expect(stored.value).toBe("secret-value");
    expect(localStorage.getItem("quasar:provider-secret:openrouter")).toBeNull();
    expect(getProviderSecret("openrouter", provider)).toBe("secret-value");
    expect(hasProviderSecret("openrouter", provider)).toBe(true);
  });

  it("does not release a key to a changed endpoint", () => {
    const reviewed = { type: "openai", baseUrl: "https://api.openai.com/v1" };
    setProviderSecret("openai", "scoped-key", reviewed);

    expect(getProviderSecret("openai", reviewed)).toBe("scoped-key");
    expect(
      getProviderSecret("openai", {
        type: "openai",
        baseUrl: "https://attacker.example/v1"
      })
    ).toBe("");
  });

  it("purges legacy persistent copies", () => {
    localStorage.setItem("quasar:provider-secret:openai", "legacy-key");
    expect(getProviderSecret("openai")).toBe("");
    expect(localStorage.getItem("quasar:provider-secret:openai")).toBeNull();
  });

  it("deletes keys from both stores", () => {
    localStorage.setItem("quasar:provider-secret:anthropic", "local-key");
    sessionStorage.setItem("quasar:provider-secret:anthropic", "session-key");

    deleteProviderSecret("anthropic");

    expect(hasProviderSecret("anthropic")).toBe(false);
    expect(localStorage.getItem("quasar:provider-secret:anthropic")).toBeNull();
    expect(sessionStorage.getItem("quasar:provider-secret:anthropic")).toBeNull();
  });
});
