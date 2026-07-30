import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MELISSA_CONFIG,
  installMelissaFetchInterceptor,
  saveMelissaConfig,
  uninstallMelissaFetchInterceptor
} from "./melissa-browser-config";

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

let previousFetch;
let previousStorage;

beforeEach(() => {
  previousFetch = globalThis.fetch;
  previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage()
  });
  uninstallMelissaFetchInterceptor();
});

afterEach(() => {
  uninstallMelissaFetchInterceptor();
  globalThis.fetch = previousFetch;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousStorage
  });
});

describe("Melissa Personator Search browser configuration", () => {
  it("injects credentials, enrichment columns, and search options", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    saveMelissaConfig({ licenseKey: "TEST-KEY", transmissionReference: "Quasar test" });
    installMelissaFetchInterceptor();

    await globalThis.fetch(
      "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch?full=Erica+Porter&last=Porter&format=JSON"
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("id")).toBe("TEST-KEY");
    expect(url.searchParams.get("t")).toBe("Quasar test");
    expect(url.searchParams.get("cols")).toBe(DEFAULT_MELISSA_CONFIG.personatorColumns);
    expect(url.searchParams.get("opt")).toBe(DEFAULT_MELISSA_CONFIG.personatorOptions);
  });

  it("preserves explicit Personator Search columns and options", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    saveMelissaConfig({
      licenseKey: "TEST-KEY",
      personatorColumns: "Email,Phone",
      personatorOptions: "SearchConditions:strict,RecordsPerPage:3"
    });
    installMelissaFetchInterceptor();

    await globalThis.fetch(
      "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch?last=Porter"
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("cols")).toBe("Email,Phone");
    expect(url.searchParams.get("opt")).toBe("SearchConditions:strict,RecordsPerPage:3");
  });
});
