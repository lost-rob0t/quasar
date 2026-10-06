import { describe, expect, it } from "vitest";
import {
  documentSchema,
  fromPouchDocument,
  migrateLegacy090Document,
  toCanonicalDocument,
  toPouchDocument
} from "./canonical-document";

const person = {
  id: "person:one",
  dataset: "test",
  dtype: "person",
  schemaVersion: "0.10.1",
  fullName: "Example",
  extensions: { opaque: { snake_key: "preserved" } }
};
describe("canonical StarLang document boundary", () => {
  it("accepts flat canonical documents without rewriting opaque maps", () => {
    expect(toCanonicalDocument(person)).toBe(person);
    expect(person.extensions.opaque.snake_key).toBe("preserved");
  });
  it("rejects nested legacy documents unless migration is selected", () => {
    expect(() =>
      toCanonicalDocument({ _id: "x", dtype: "person", schema_version: "0.9.0", data: {} })
    ).toThrow(/select legacy/);
  });
  it("migrates known flat fields and timestamps with exact seconds", () => {
    expect(
      migrateLegacy090Document({
        _id: "person:one",
        dataset: "test",
        dtype: "person",
        schema_version: "0.9.0",
        date_added: "2026-01-01T00:00:00Z",
        data: { full_name: "Example" }
      })
    ).toEqual({
      id: "person:one",
      dataset: "test",
      dtype: "person",
      schemaVersion: "0.10.1",
      createdAt: 1767225600,
      fullName: "Example"
    });
  });
  it("rejects unmapped historical fields rather than discarding them", () => {
    expect(() =>
      migrateLegacy090Document({
        _id: "x",
        dataset: "test",
        dtype: "person",
        schema_version: "0.9.0",
        data: { made_up: "value" }
      })
    ).toThrow(/Unmapped historical field/);
  });
  it("rejects fabricated version labels and conflicting identity aliases", () => {
    expect(() => toCanonicalDocument({ ...person, data: {} })).toThrow();
    expect(() =>
      migrateLegacy090Document({
        _id: "x",
        id: "y",
        dataset: "test",
        dtype: "person",
        schema_version: "0.9.0",
        data: {}
      })
    ).toThrow(/Conflicting/);
  });
  it("separates Couch metadata and preserves the canonical wire contract", () => {
    const stored = toPouchDocument({ ...person, rev: "2-rev" });
    expect(stored._id).toBe(person.id);
    expect(fromPouchDocument(stored)).toEqual({ ...person, rev: "2-rev" });
    expect(() => fromPouchDocument({ ...stored, _id: "other" })).toThrow(/disagrees/);
  });
  it("loads concrete generated fields, including canonical relations", () => {
    expect(documentSchema("person").properties.fullName).toEqual({ type: "string" });
    expect(documentSchema("relation").required).toContain("destination");
  });
});

it("roundtrips known legacy metadata, decimal confidence and typed references", async () => {
  const { toLegacyUiDocument } = await import("./canonical-document");
  const legacy = {
    _id: "rel:1",
    dtype: "relation",
    dataset: "test",
    schema_version: "0.9.0",
    title: "Original title",
    version: 3,
    date_added: "2026-01-01T00:00:00.123Z",
    data: {
      subject: "person:a",
      object: "person:b",
      predicate: "knows",
      confidence: 0.7,
      active: true
    }
  };
  const canonical = migrateLegacy090Document(legacy);
  expect(canonical.source).toEqual({ schema: "org.starintel/core@1/document", id: "person:a" });
  expect(canonical.confidence).toBe("0.7");
  expect(canonical.extensions.quasarLegacy090).toMatchObject({
    title: "Original title",
    data: { active: true },
    date_added: legacy.date_added
  });
  expect(migrateLegacy090Document(toLegacyUiDocument(canonical))).toEqual(canonical);
});

it("rejects compatibility extension overwrite collisions", () => {
  expect(() =>
    migrateLegacy090Document({
      _id: "x",
      dtype: "person",
      dataset: "test",
      schema_version: "0.9.0",
      title: "new",
      extensions: { quasarLegacy090: { title: "preserve" } },
      data: {}
    })
  ).toThrow(/overwritten/);
});

it("rejects unsafe JSON numbers before browser storage can round opaque payloads", async () => {
  const { parseBrowserDocumentJson } = await import("./canonical-document");
  expect(() => parseBrowserDocumentJson('{"extensions":{"opaque":9007199254740993}}')).toThrow(
    /instead of rounding/
  );
  expect(parseBrowserDocumentJson('{"extensions":{"opaque":{"isLosslessNumber":true}}}')).toEqual({
    extensions: { opaque: { isLosslessNumber: true } }
  });
});

it("does not let preserved fractional history overwrite a newer canonical edit timestamp", async () => {
  const { toLegacyUiDocument } = await import("./canonical-document");
  const migrated = migrateLegacy090Document({
    _id: "person:timestamp",
    dataset: "test",
    dtype: "person",
    schema_version: "0.9.0",
    date_updated: "2026-01-01T00:00:00.123Z",
    data: {}
  });
  const edited = { ...migrated, updatedAt: migrated.updatedAt + 60 };
  expect(migrateLegacy090Document(toLegacyUiDocument(edited)).updatedAt).toBe(edited.updatedAt);
});
