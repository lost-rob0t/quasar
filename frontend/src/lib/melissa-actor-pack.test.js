import { assertDocument } from "starintel_doc";
import { describe, expect, it, vi } from "vitest";
import {
  MELISSA_ACTORS,
  MELISSA_ACTOR_PACK_VERSION,
  mergeMelissaActors,
  removeMelissaActors
} from "./melissa-actor-pack";

const stamp = "2026-07-28T00:00:00.000Z";

function input(overrides = {}) {
  return {
    _id: "starintel:person:input",
    dataset: "test",
    dtype: "person",
    schema_version: "0.9.0",
    version: 1,
    date_added: stamp,
    date_updated: stamp,
    title: "Ada Lovelace",
    sources: [],
    evidence: [],
    data: { full_name: "Ada Lovelace" },
    ...overrides
  };
}

function implementation(service) {
  const actor = MELISSA_ACTORS.find((candidate) => candidate.service === service);
  return Function(`"use strict"; return (${actor.source});`)();
}

function api(body) {
  return {
    progress: vi.fn(),
    network: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, body }))
    }
  };
}

describe("Melissa actor pack", () => {
  it("ships 11 executable actor manifests", () => {
    expect(MELISSA_ACTOR_PACK_VERSION).toBe(2);
    expect(MELISSA_ACTORS).toHaveLength(11);
    for (const actor of MELISSA_ACTORS) {
      expect(Function(`"use strict"; return (${actor.source});`)()).toBeTypeOf("function");
      expect(actor.capabilities).toEqual(["network.fetch"]);
    }
  });

  it("merges and removes the pack without replacing unrelated actors", () => {
    const custom = { id: "example.actor" };
    const merged = mergeMelissaActors([custom, MELISSA_ACTORS[0]]);
    expect(merged.filter((actor) => actor.id === MELISSA_ACTORS[0].id)).toHaveLength(1);
    expect(merged).toContain(custom);
    expect(removeMelissaActors(merged)).toEqual([custom]);
  });

  it("normalizes person matches into valid person, location, phone, email, and relation documents", async () => {
    const runtime = api({
      Records: [
        {
          FullName: "Ada Lovelace",
          FirstName: "Ada",
          LastName: "Lovelace",
          EmailAddress: "ada@example.com",
          PhoneNumber: "+15551234567",
          AddressLine1: "1 Main St",
          City: "Columbus",
          State: "OH",
          PostalCode: "43215",
          CountryAbbreviation: "US",
          MelissaIdentityKey: "MIK123",
          Results: "PS01",
          Confidence: "9"
        }
      ]
    });

    const result = await implementation("personator-search")({ selection: [input()] }, runtime);
    const dtypes = result.documents.map((document) => document.dtype);

    expect(dtypes).toEqual(
      expect.arrayContaining(["person", "location", "phone", "email", "relation"])
    );
    expect(runtime.network.fetch).toHaveBeenCalledOnce();
    expect(runtime.network.fetch.mock.calls[0][0].url).not.toContain("id=");
    expect(result.documents.find((document) => document.dtype === "person")?.data).toMatchObject({
      full_name: "Ada Lovelace",
      fname: "Ada",
      lname: "Lovelace"
    });
    expect(result.documents.find((document) => document.dtype === "phone")?.data.number).toBe(
      "+15551234567"
    );
    expect(result.documents.find((document) => document.dtype === "email")?.data.address).toBe(
      "ada@example.com"
    );
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("extracts Personator names from document title, main, and split name fields", async () => {
    const runtime = api({ Records: [] });
    const titleOnly = input({
      _id: "starintel:person:title-only",
      title: "Grace Hopper",
      data: {}
    });
    const mainOnly = input({
      _id: "starintel:person:main-only",
      title: "Person",
      data: { main: "Katherine Johnson" }
    });
    const splitName = input({
      _id: "starintel:person:split-name",
      title: "Person",
      data: { fname: "Dorothy", mname: "Vaughan", lname: "Johnson" }
    });

    await implementation("personator-search")(
      {
        selection: [titleOnly, mainOnly, splitName]
      },
      runtime
    );

    const names = runtime.network.fetch.mock.calls.map(([request]) =>
      new URL(request.url).searchParams.get("full")
    );
    expect(names).toEqual(["Grace Hopper", "Katherine Johnson", "Dorothy Vaughan Johnson"]);
  });

  it("creates valid reverse-geocoded location documents", async () => {
    const runtime = api({
      Records: [
        {
          AddressLine1: "100 Broad St",
          City: "Columbus",
          State: "OH",
          PostalCode: "43215",
          CountryAbbreviation: "US",
          Latitude: "39.9612",
          Longitude: "-82.9988",
          MelissaAddressKey: "MAK123"
        }
      ]
    });
    const location = input({
      _id: "starintel:location:input",
      dtype: "location",
      title: "Coordinates",
      data: { name: "Coordinates", lat: 39.9612, long: -82.9988 }
    });

    const result = await implementation("reverse-geocoder")({ selection: [location] }, runtime);
    const output = result.documents.find((document) => document.dtype === "location");

    expect(output.data).toMatchObject({
      street: "100 Broad St",
      city: "Columbus",
      state: "OH",
      postal: "43215",
      lat: 39.9612,
      long: -82.9988
    });
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("creates a property asset, location, owner person, and explicit relations", async () => {
    const runtime = api({
      Records: [
        {
          AddressLine1: "100 Broad St",
          City: "Columbus",
          State: "OH",
          PostalCode: "43215",
          CountryAbbreviation: "US",
          APN: "010-123456",
          PrimaryOwnerName: "Example Owner",
          OwnerType: "Individual",
          Results: "YS01"
        }
      ]
    });
    const address = input({
      _id: "starintel:location:property-input",
      dtype: "location",
      title: "100 Broad St",
      data: {
        name: "100 Broad St",
        street: "100 Broad St",
        city: "Columbus",
        state: "OH",
        postal: "43215"
      }
    });

    const result = await implementation("property")({ selection: [address] }, runtime);

    expect(
      result.documents.some(
        (document) => document.dtype === "asset" && document.data.asset_type === "property"
      )
    ).toBe(true);
    expect(
      result.documents.some(
        (document) => document.dtype === "person" && document.data.full_name === "Example Owner"
      )
    ).toBe(true);
    expect(
      result.documents.some(
        (document) => document.dtype === "relation" && document.data.predicate === "owned-by"
      )
    ).toBe(true);
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("requires service-specific input before issuing a request", async () => {
    const runtime = api({ Records: [] });
    await expect(implementation("global-phone")({ selection: [input()] }, runtime)).rejects.toThrow(
      "requires a phone number"
    );
    expect(runtime.network.fetch).not.toHaveBeenCalled();
  });
});
