import { describe, expect, it, vi } from "vitest";
import {
  buildMelissaPersonatorTestUrl,
  describeMelissaLicenseKey,
  testMelissaPersonatorSearch
} from "./melissa-personator-test";

describe("manual Personator Search credential test", () => {
  it("places the exact credit key in the documented request", () => {
    const url = buildMelissaPersonatorTestUrl("CR+ED/IT==");

    expect(url.origin + url.pathname).toBe(
      "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch"
    );
    expect(url.searchParams.get("id")).toBe("CR+ED/IT==");
    expect(url.searchParams.get("full")).toBe("Melissa Data");
    expect(url.searchParams.get("a1")).toBe("22382 Avenida Empresa");
    expect(url.searchParams.get("city")).toBe("Rancho Santa Margarita");
    expect(url.searchParams.get("state")).toBe("CA");
    expect(url.searchParams.get("postal")).toBe("92688");
    expect(url.href).toContain("id=CR%2BED%2FIT%3D%3D");
  });

  it("does not strip labels, quotes, whitespace, or symbols from the supplied value", () => {
    const exact = ' License Key Using Credits: "CR+ED/IT==" ';
    const url = buildMelissaPersonatorTestUrl(exact);

    expect(url.searchParams.get("id")).toBe(exact);
  });

  it("reports the service response without exposing the full key", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            TransmissionResults: "US01",
            TotalRecords: "1",
            Version: "test",
            Records: [{ RecordID: "1" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );

    const result = await testMelissaPersonatorSearch("CR+ED/IT==", { fetchImpl });

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      transmissionResults: "US01",
      totalRecords: 1,
      version: "test",
      key: {
        length: 10,
        ending: "IT==",
        sentUnchanged: true,
        whitespaceCount: 0,
        invisibleCount: 0
      }
    });
    expect(result.key).not.toHaveProperty("value");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("id=CR%2BED%2FIT%3D%3D");
  });

  it("reports GE05 as a rejected exact credential", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ TransmissionResults: "GE05", Records: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );

    await expect(testMelissaPersonatorSearch("CREDIT-KEY", { fetchImpl })).resolves.toMatchObject({
      ok: false,
      errorCode: "GE05",
      transmissionResults: "GE05"
    });
  });

  it("uses a stable masked key description", () => {
    expect(describeMelissaLicenseKey("CREDIT-KEY")).toMatchObject({
      length: 10,
      ending: "-KEY",
      fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
      sentUnchanged: true,
      leadingOrTrailingWhitespace: false,
      whitespaceCount: 0,
      invisibleCount: 0
    });
  });
});
