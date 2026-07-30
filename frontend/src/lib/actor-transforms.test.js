import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveActorConfiguration } from "./actor-configuration";
import {
  actorWithTransformEnvelope,
  buildActorTransform,
  normalizeActorTransformResult
} from "./actor-transforms";

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

const stamp = "2026-07-26T01:00:00.000Z";
const org = {
  _id: "starintel:org:test",
  dataset: "test",
  dtype: "org",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: "Test org",
  sources: [],
  evidence: [],
  data: { name: "Test org" }
};
const relation = {
  _id: "starintel:relation:test-related",
  dataset: "test",
  dtype: "relation",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: "related-to",
  sources: [],
  evidence: [],
  data: {
    subject: org._id,
    predicate: "related-to",
    object: "starintel:org:other",
    directed: true
  }
};

describe("actor transform results", () => {
  it("keeps legacy returned documents as canonical upsert transforms", () => {
    const result = normalizeActorTransformResult({ documents: [org], message: "legacy" });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      op: "upsert_document",
      document: org
    });
    expect(result.operations[0].document).toMatchObject({
      schema_revision: expect.any(String),
      profile: expect.any(String),
      profile_version: expect.any(String)
    });
    expect(result.legacyDocumentCount).toBe(1);
  });

  it("accepts operations-only actors and injects local configuration", () => {
    const actor = {
      id: "test.actor",
      label: "Test actor",
      source:
        "(context) => ({ operations: [{ op: 'remove_document', id: context.configuration.removeId }] })"
    };
    saveActorConfiguration(actor, { removeId: "x" });
    const wrapped = actorWithTransformEnvelope(actor);

    expect(wrapped.source).toContain("documents: []");
    expect(wrapped.source).toContain("implementation(configuredContext, api)");
    expect(wrapped.source).toContain('"removeId":"x"');
    expect(wrapped.source).not.toContain("implementation(context, api)");
  });

  it("builds one undoable batch for create, update, relation, and remove transforms", () => {
    const updated = {
      ...org,
      version: 2,
      date_updated: "2026-07-26T02:00:00.000Z",
      title: "Updated org",
      data: { name: "Updated org" }
    };
    const created = {
      ...org,
      _id: "starintel:org:created",
      title: "Created org",
      data: { name: "Created org" }
    };
    const transform = buildActorTransform(
      {
        operations: [
          { op: "update_document", document: updated },
          { op: "create_document", document: created },
          { op: "create_relation", document: relation },
          { op: "remove_document", id: created._id },
          { op: "remove_relation", id: relation._id }
        ]
      },
      [org],
      "Actor: test"
    );

    expect(transform.command.type).toBe("batch");
    expect(transform.command.operations).toHaveLength(5);
    expect(transform.counts).toEqual({
      created: 1,
      updated: 1,
      upserted: 0,
      removed: 1,
      relationsCreated: 1,
      relationsRemoved: 1
    });
    expect(transform.documents.map((document) => document._id)).toEqual([org._id]);
    expect(transform.removedIds).toEqual([created._id, relation._id]);
  });

  it("preflights the whole plan before returning a mutation command", () => {
    expect(() =>
      buildActorTransform(
        {
          operations: [{ op: "create_document", document: org }]
        },
        [org]
      )
    ).toThrow("cannot create existing document");

    expect(() =>
      buildActorTransform(
        {
          operations: [{ op: "update_document", document: org }]
        },
        []
      )
    ).toThrow("cannot update missing document");

    expect(() =>
      buildActorTransform(
        {
          operations: [{ op: "remove_relation", id: org._id }]
        },
        [org]
      )
    ).toThrow("cannot remove non-relation");
  });

  it("rejects unsupported operation names and malformed documents", () => {
    expect(() =>
      normalizeActorTransformResult({
        operations: [{ op: "mutate_cytoscape", id: org._id }]
      })
    ).toThrow("Unsupported actor operation");

    expect(() =>
      normalizeActorTransformResult({
        operations: [
          {
            op: "create_document",
            document: { ...org, dtype: "not-a-real-dtype" }
          }
        ]
      })
    ).toThrow("Invalid StarIntel v0.9 document");
  });
});
