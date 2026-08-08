import { assertDocument } from "starintel_doc";
import { describe, expect, it, vi } from "vitest";
import {
  MELISSA_ACTORS,
  MELISSA_ACTOR_PACK_VERSION,
  mergeMelissaActors,
  removeMelissaActors
} from "./melissa-actor-pack-runtime";

const stamp = "2026-07-29T00:00:00.000Z";

function input(overrides = {}) {
  return {
    _id: "starintel:person:input",
    dataset: "test",
    dtype: "person",
    schema_version: "0.9.0",
    version: 1,
    date_added: stamp,
    date_updated: stamp,
    title: "Erica Porter",
    sources: [],
    evidence: [],
    data: { full_name: "Erica Porter" },
    ...overrides
  };
}

function implementation() {
  const actor = MELISSA_ACTORS.find((candidate) => candidate.service === "personator-search");
  return Function(`"use strict"; return (${actor.source});`)();
}

function api(body = { TransmissionResults: "US01", Records: [] }) {
  return {
    progress: vi.fn(),
    network: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, body }))
    }
  };
}

describe("Melissa runtime actor pack", () => {
  it("publishes version 5 actors and replaces stale pack entries", () => {
    expect(MELISSA_ACTOR_PACK_VERSION).toBe(5);
    expect(MELISSA_ACTORS).toHaveLength(11);
    expect(MELISSA_ACTORS.every((actor) => actor.version === 5)).toBe(true);

    const custom = { id: "example.actor" };
    const stale = { ...MELISSA_ACTORS[0], version: 1, source: "async () => ({ documents: [] })" };
    const merged = mergeMelissaActors([custom, stale]);

    expect(merged).toContain(custom);
    expect(merged.find((actor) => actor.id === stale.id)?.version).toBe(5);
    expect(removeMelissaActors(merged)).toEqual([custom]);
  });

  it("builds documented name inputs from a person title", async () => {
    const runtime = api();

    await implementation()({ selection: [input({ data: {} })] }, runtime);

    const url = new URL(runtime.network.fetch.mock.calls[0][0].url);
    expect(url.origin + url.pathname).toBe(
      "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch"
    );
    expect(url.searchParams.get("full")).toBe("Erica Porter");
    expect(url.searchParams.get("first")).toBe("Erica");
    expect(url.searchParams.get("last")).toBe("Porter");
    expect(url.searchParams.get("format")).toBe("JSON");
    expect(url.searchParams.has("id")).toBe(false);
  });

  it("normalizes the documented nested response into linked graph documents", async () => {
    const runtime = api({
      TransmissionResults: "US01",
      TransmissionReference: "Quasar test",
      TotalPages: "1",
      TotalRecords: "1",
      Version: "9.2.5.1145",
      Records: [
        {
          RecordID: "1",
          Results: "US01",
          FullName: "Erica Porter",
          FirstName: "Erica",
          MiddleName: "A",
          LastName: "Porter",
          Suffix: "",
          DateOfBirth: "198201",
          DateOfDeath: "",
          MelissaIdentityKey: "MIK123",
          CurrentAddress: {
            AddressLine1: "1 Main St",
            Suite: "",
            City: "Columbus",
            State: "OH",
            PostalCode: "43215",
            Plus4: "1234",
            MelissaAddressKey: "MAK123",
            MelissaAddressKeyBase: "",
            MoveDate: "20200101"
          },
          PreviousAddresses: [
            {
              AddressLine1: "2 Old St",
              Suite: "",
              City: "Dayton",
              State: "OH",
              PostalCode: "45402",
              Plus4: "",
              MelissaAddressKey: "MAK456",
              MelissaAddressKeyBase: "",
              MoveDate: "20100101"
            }
          ],
          PhoneRecords: [{ phoneNumber: "6145550101" }, { phoneNumber: "6145550102" }],
          EmailRecords: [{ email: "ERICA@example.com" }, { email: "other@example.com" }]
        }
      ]
    });

    const result = await implementation()({ selection: [input()] }, runtime);
    const typed = (dtype) => result.documents.filter((document) => document.dtype === dtype);
    const person = typed("person")[0];

    expect(person.data).toMatchObject({
      full_name: "Erica Porter",
      fname: "Erica",
      mname: "A",
      lname: "Porter",
      dob: "1982-01-01T00:00:00.000Z"
    });
    expect(person.data.external_ids).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scheme: "melissa-identity-key", value: "MIK123" })
      ])
    );
    expect(typed("location")).toHaveLength(2);
    expect(typed("phone").map((document) => document.data.number)).toEqual([
      "6145550101",
      "6145550102"
    ]);
    expect(typed("email").map((document) => document.data.address)).toEqual([
      "erica@example.com",
      "other@example.com"
    ]);

    const predicates = typed("relation").map((document) => document.data.predicate);
    expect(predicates).toEqual(
      expect.arrayContaining([
        "matched-to",
        "located-at",
        "previously-located-at",
        "has-phone",
        "has-email"
      ])
    );
    expect(result.metrics.matches).toBe(1);
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("rejects service-level errors without returning documents", async () => {
    const runtime = api({
      TransmissionResults: "GE08",
      Records: [{ FullName: "Erica Porter" }]
    });

    await expect(implementation()({ selection: [input()] }, runtime)).rejects.toThrow(
      "GE08 (product or level not enabled)"
    );
  });

  it("drops no-match and record-error responses", async () => {
    const runtime = api({
      TransmissionResults: "US01",
      Records: [{ Results: "UE01", FullName: "Erica Porter" }]
    });

    const result = await implementation()({ selection: [input()] }, runtime);

    expect(result.documents).toEqual([]);
    expect(result.metrics).toMatchObject({ outputs: 0, matches: 0, skipped: 1 });
  });

  it("requires a documented minimum input set before calling Melissa", async () => {
    const runtime = api();
    const empty = input({ dtype: "entity", title: "Input", data: {} });

    await expect(implementation()({ selection: [empty] }, runtime)).rejects.toThrow(
      "Personator Search requires"
    );
    expect(runtime.network.fetch).not.toHaveBeenCalled();
  });
});
