import {
  fetchMelissaDirect,
  inspectMelissaLicenseKey,
  normalizeMelissaLicenseKey
} from "./melissa-browser-config";

export const MELISSA_PERSONATOR_TEST_RECORD = Object.freeze({
  full: "Melissa Data",
  address1: "22382 Avenida Empresa",
  city: "Rancho Santa Margarita",
  state: "CA",
  postal: "92688"
});

function keyFingerprint(value) {
  let state = 0x811c9dc5;
  for (const character of value) {
    state ^= character.codePointAt(0);
    state = Math.imul(state, 0x01000193);
  }
  return (state >>> 0).toString(16).padStart(8, "0");
}

export function describeMelissaLicenseKey(value) {
  const licenseKey = normalizeMelissaLicenseKey(value);
  return {
    ...inspectMelissaLicenseKey(licenseKey),
    ending: licenseKey ? licenseKey.slice(-4) : "",
    fingerprint: licenseKey ? keyFingerprint(licenseKey) : "",
    sentUnchanged: true
  };
}

export function buildMelissaPersonatorTestUrl(licenseKey, record = MELISSA_PERSONATOR_TEST_RECORD) {
  const exact = normalizeMelissaLicenseKey(licenseKey);
  if (!exact) throw new Error("Paste the Melissa License Key Using Credits before testing");

  const url = new URL("https://personatorsearch.melissadata.net/WEB/doPersonatorSearch");
  url.searchParams.set("id", exact);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("t", "Quasar manual credential test");
  url.searchParams.set("full", String(record.full || ""));
  url.searchParams.set("a1", String(record.address1 || ""));
  url.searchParams.set("city", String(record.city || ""));
  url.searchParams.set("state", String(record.state || ""));
  url.searchParams.set("postal", String(record.postal || ""));
  return url;
}

function transmissionCodes(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export async function testMelissaPersonatorSearch(
  licenseKey,
  { fetchImpl = fetchMelissaDirect, record = MELISSA_PERSONATOR_TEST_RECORD } = {}
) {
  if (typeof fetchImpl !== "function") throw new Error("Browser fetch is unavailable");

  const url = buildMelissaPersonatorTestUrl(licenseKey, record);
  const response = await fetchImpl(url.href, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "omit",
    cache: "no-store"
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Melissa returned non-JSON HTTP ${response.status}: ${raw.slice(0, 160)}`);
  }

  const transmissionResults = String(
    body?.TransmissionResults || body?.TransmissionResult || ""
  ).trim();
  const errorCode = transmissionCodes(transmissionResults).find((code) =>
    /^(?:GE|SE)\d{2}$/.test(code)
  );
  const records = Array.isArray(body?.Records) ? body.Records : [];

  return {
    ok: response.ok && !errorCode,
    httpStatus: response.status,
    transmissionResults: transmissionResults || "(missing)",
    errorCode: errorCode || "",
    totalRecords: Number(body?.TotalRecords ?? records.length) || 0,
    version: String(body?.Version || ""),
    key: describeMelissaLicenseKey(licenseKey),
    endpoint: `${url.origin}${url.pathname}`,
    sample: { ...record }
  };
}
