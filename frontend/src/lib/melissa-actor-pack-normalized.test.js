import { assertDocument } from "starintel_doc";
import { describe, expect, it, vi } from "vitest";
import { MELISSA_ACTORS, MELISSA_ACTOR_PACK_VERSION } from "./melissa-actor-pack-normalized";

const stamp = "2026-07-28T00:00:00.000Z";

function input(overrides = {}) {
  return {
    _id: "starintel:entity:input",
    dataset: "test",
    dtype: "entity",
    schema_version: "0.9.0",
    version: 1,
    date_added: stamp,
    date_updated: stamp,
    title: "Input",
    sources: [],
    evidence: [],
    data: {},
    ...overrides
  };
}

function implementation(service) {
  const actor = MELISSA_ACTORS.find((candidate) => candidate.service === service);
  return Function(`"use strict"; return (${actor.source});`)();
}

function api(body = { Records: [] }) {
  return {
    progress: vi.fn(),
    network: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, body }))
    }
  };
}

async function requestFor(service, document) {
  const runtime = api();
  await implementation(service)({ selection: [document] }, runtime);
  expect(runtime.network.fetch).toHaveBeenCalledOnce();
  return new URL(runtime.network.fetch.mock.calls[0][0].url);
}

describe("normalized Melissa actor pack", () => {
  it("publishes version 4 actors", () => {
    expect(MELISSA_ACTOR_PACK_VERSION).toBe(4);
    expect(MELISSA_ACTORS).toHaveLength(11);
    expect(MELISSA_ACTORS.every((actor) => actor.version === 4)).toBe(true);
  });

  it("extracts canonical values and typed document titles for every service", async () => {
    const cases = [
      [
        "personator-search",
        input({ dtype: "person", title: "Grace Hopper" }),
        "full",
        "Grace Hopper"
      ],
      [
        "people-business-search",
        input({ dtype: "org", title: "Example Industries" }),
        "anyname",
        "Example Industries"
      ],
      [
        "personator-consumer",
        input({
          dtype: "person",
          title: "Person",
          data: { fname: "Dorothy", lname: "Vaughan" }
        }),
        "full",
        "Dorothy Vaughan"
      ],
      [
        "personator-identity",
        input({ dtype: "person", title: "Katherine Johnson" }),
        "full",
        "Katherine Johnson"
      ],
      [
        "reverse-geocoder",
        input({
          dtype: "location",
          title: "Coordinates",
          data: { geometry: { coordinates: [-82.9988, 39.9612] } }
        }),
        "lat",
        "39.9612"
      ],
      [
        "property",
        input({ dtype: "location", title: "100 Broad St, Columbus, OH 43215" }),
        "a1",
        "100 Broad St, Columbus, OH 43215"
      ],
      [
        "global-address",
        input({ dtype: "address", title: "100 Broad St, Columbus, OH 43215" }),
        "a1",
        "100 Broad St, Columbus, OH 43215"
      ],
      [
        "global-name",
        input({ dtype: "org", title: "Example Industries" }),
        "comp",
        "Example Industries"
      ],
      ["global-phone", input({ dtype: "phone", title: "+16145551234" }), "phone", "+16145551234"],
      [
        "global-email",
        input({ dtype: "email", title: "person@example.com" }),
        "email",
        "person@example.com"
      ],
      ["global-ip", input({ dtype: "ip", title: "203.0.113.10" }), "ip", "203.0.113.10"]
    ];

    for (const [service, document, parameter, expected] of cases) {
      const url = await requestFor(service, document);
      expect(url.searchParams.get(parameter), service).toBe(expected);
    }
  });

  it("extracts property identifiers from canonical external_ids", async () => {
    const url = await requestFor(
      "property",
      input({
        dtype: "asset",
        title: "Property",
        data: {
          external_ids: [
            {
              scheme: "melissa-address-key",
              value: "MAK123",
              issuer: "Melissa"
            }
          ]
        }
      })
    );

    expect(url.searchParams.get("mak")).toBe("MAK123");
  });

  it("returns Personator matches as linked graph documents", async () => {
    const runtime = api({
      Records: [
        {
          FullName: "Ada Lovelace",
          FirstName: "Ada",
          LastName: "Lovelace",
          CompanyName: "Analytical Engines Ltd",
          AddressLine1: "1 Main St",
          City: "Columbus",
          State: "OH",
          PostalCode: "43215",
          PhoneNumber: "+16145551234",
          EmailAddress: "ada@example.com",
          MelissaIdentityKey: "MIK123"
        }
      ]
    });

    const result = await implementation("personator-search")(
      {
        selection: [
          input({
            _id: "starintel:person:ada-input",
            dtype: "person",
            title: "Ada Lovelace"
          })
        ]
      },
      runtime
    );

    const person = result.documents.find((document) => document.dtype === "person");
    const org = result.documents.find((document) => document.dtype === "org");
    const location = result.documents.find((document) => document.dtype === "location");
    const phone = result.documents.find((document) => document.dtype === "phone");
    const email = result.documents.find((document) => document.dtype === "email");

    expect(person).toBeDefined();
    expect(org?.data.name).toBe("Analytical Engines Ltd");
    expect(location?.data.street).toBe("1 Main St");
    expect(phone?.data.number).toBe("+16145551234");
    expect(email?.data.address).toBe("ada@example.com");
    expect(person.data).not.toHaveProperty("address");
    expect(person.data).not.toHaveProperty("phone");
    expect(person.data).not.toHaveProperty("email");
    expect(person.data).not.toHaveProperty("company");

    const predicates = result.documents
      .filter((document) => document.dtype === "relation" && document.data.subject === person._id)
      .map((document) => document.data.predicate);

    expect(predicates).toEqual(
      expect.arrayContaining(["located-at", "has-phone", "has-email", "associated-with"])
    );
    result.documents.forEach((document) => expect(() => assertDocument(document)).not.toThrow());
  });

  it("rejects service-level Melissa errors before creating documents", async () => {
    const runtime = api({
      TransmissionResults: "GE08",
      Records: [
        {
          FullName: "Erica Porter",
          Results: ""
        }
      ]
    });

    await expect(
      implementation("personator-search")(
        {
          selection: [input({ dtype: "person", title: "Erica Porter" })]
        },
        runtime
      )
    ).rejects.toThrow("GE08 (product or service level not enabled)");
  });

  it("drops record-level Melissa error records", async () => {
    const runtime = api({
      Records: [
        {
          FullName: "Erica Porter",
          Results: "UE01"
        }
      ]
    });

    const result = await implementation("personator-search")(
      {
        selection: [input({ dtype: "person", title: "Erica Porter" })]
      },
      runtime
    );

    expect(result.documents).toEqual([]);
    expect(result.metrics.outputs).toBe(0);
  });

  it("rejects missing inputs before network requests for every validated service", async () => {
    const services = [
      "personator-search",
      "people-business-search",
      "personator-consumer",
      "personator-identity",
      "reverse-geocoder",
      "property",
      "global-address",
      "global-name",
      "global-phone",
      "global-email",
      "global-ip"
    ];

    for (const service of services) {
      const runtime = api();
      await expect(implementation(service)({ selection: [input()] }, runtime)).rejects.toThrow(
        "could not extract"
      );
      expect(runtime.network.fetch, service).not.toHaveBeenCalled();
    }
  });
});
