import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMelissaConfig,
  fetchMelissaDirect,
  inspectMelissaLicenseKey,
  installMelissaFetchInterceptor,
  loadMelissaConfig,
  MELISSA_CONFIG_STORAGE_KEY,
  normalizeMelissaLicenseKey,
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
  clear() {
    this.values.clear();
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
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousStorage });
});

describe("Melissa browser configuration", () => {
  it("persists configuration in browser storage", () => {
    const saved = saveMelissaConfig({
      licenseKey: "TEST-KEY",
      defaultCountry: "ca",
      maxRecords: 500,
      identityAction: "Screen"
    });

    expect(saved.defaultCountry).toBe("CA");
    expect(saved.maxRecords).toBe(100);
    expect(loadMelissaConfig()).toMatchObject({
      licenseKey: "TEST-KEY",
      defaultCountry: "CA",
      identityAction: "Screen"
    });
    expect(localStorage.getItem(MELISSA_CONFIG_STORAGE_KEY)).toContain("TEST-KEY");

    clearMelissaConfig();
    expect(loadMelissaConfig().licenseKey).toBe("");
  });

  it("preserves the exact license key instead of rewriting copied text", () => {
    const exact = "License Key Using Credits:\nCopy\nCR+ED/IT==";

    expect(normalizeMelissaLicenseKey(exact)).toBe(exact);
    expect(normalizeMelissaLicenseKey('"CR+ED/IT=="')).toBe('"CR+ED/IT=="');
    expect(normalizeMelissaLicenseKey(" CR_EDIT_KEY ")).toBe(" CR_EDIT_KEY ");
    expect(inspectMelissaLicenseKey(" CR_EDIT_KEY\u200b ")).toEqual({
      length: 14,
      leadingOrTrailingWhitespace: true,
      whitespaceCount: 2,
      invisibleCount: 1
    });
  });

  it("injects credentials and service defaults only into Melissa requests", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    saveMelissaConfig({
      licenseKey: "TEST-KEY",
      transmissionReference: "Quasar test",
      defaultCountry: "US",
      maxRecords: 25,
      matchLevel: 8
    });
    installMelissaFetchInterceptor();

    await globalThis.fetch(
      "https://search.melissadata.net/V5/WEB/contactsearch/docontactSearch?anyname=Ada"
    );
    await globalThis.fetch("https://example.com/data.json");

    const melissaUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(melissaUrl.searchParams.get("id")).toBe("TEST-KEY");
    expect(melissaUrl.searchParams.get("t")).toBe("Quasar test");
    expect(melissaUrl.searchParams.get("maxrecords")).toBe("25");
    expect(melissaUrl.searchParams.get("matchlevel")).toBe("8");
    expect(fetchMock.mock.calls[1][0]).toBe("https://example.com/data.json");
  });

  it("preserves and URL-encodes credit-license symbols exactly", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    saveMelissaConfig({ licenseKey: "CR+ED/IT==" });
    installMelissaFetchInterceptor();

    await globalThis.fetch(
      "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch?last=Porter&format=JSON"
    );

    const requested = String(fetchMock.mock.calls[0][0]);
    const url = new URL(requested);
    expect(url.searchParams.get("id")).toBe("CR+ED/IT==");
    expect(requested).toContain("id=CR%2BED%2FIT%3D%3D");
  });

  it("can bypass all interceptor defaults for the manual credential test", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    saveMelissaConfig({
      licenseKey: "SAVED-KEY",
      personatorColumns: "PreviousAddress",
      personatorOptions: "RecordsPerPage:10"
    });
    installMelissaFetchInterceptor();

    await fetchMelissaDirect(
      "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch?id=EXACT-KEY&format=JSON"
    );

    const requested = new URL(fetchMock.mock.calls[0][0]);
    expect(requested.searchParams.get("id")).toBe("EXACT-KEY");
    expect(requested.searchParams.has("cols")).toBe(false);
    expect(requested.searchParams.has("opt")).toBe(false);
  });

  it("supports a persisted CORS proxy template", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchMock;
    saveMelissaConfig({
      licenseKey: "TEST-KEY",
      proxyTemplate: "https://proxy.example/fetch?url={url}"
    });
    installMelissaFetchInterceptor();

    await globalThis.fetch(
      "https://globalemail.melissadata.net/V4/WEB/GlobalEmail/doGlobalEmail?email=ada@example.com"
    );

    const called = new URL(fetchMock.mock.calls[0][0]);
    expect(called.hostname).toBe("proxy.example");
    expect(decodeURIComponent(called.searchParams.get("url"))).toContain("id=TEST-KEY");
  });
});
