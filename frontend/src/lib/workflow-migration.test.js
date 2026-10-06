import { describe, expect, it } from "vitest";
import fixtures from "starintel_doc/fixtures/supported-workflows";
import { workflowMappings, schema, documentTypes } from "starintel_doc";
import { migrateLegacy090Document, toLegacyUiDocument } from "./canonical-document";

function semanticValue(value, field) {
  if (field?.$ref) return semanticValue(value, schema.$defs[field.$ref.split("/").at(-1)]);
  if (field?.anyOf)
    return semanticValue(
      value,
      field.anyOf.find((item) => (value === null ? item.type === "null" : item.type !== "null"))
    );
  if (field?.type === "string" && field.pattern?.includes("[0-9]") && typeof value === "string")
    return Number(value);
  if (Array.isArray(value) && field?.items)
    return value.map((item) => semanticValue(item, field.items));
  if (value && typeof value === "object" && field?.properties)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, semanticValue(item, field.properties[key])])
    );
  return value;
}

describe("locked supported workflow migrations", () => {
  for (const fixture of fixtures.filter((item) => item.valid && item.legacyData)) {
    it(`maps native ${fixture.document.dtype} fields and reverses without opaque wrapping`, () => {
      const input = {
        _id: fixture.document.id,
        dataset: fixture.document.dataset,
        dtype: fixture.document.dtype,
        schema_version: "0.9.0",
        data: fixture.legacyData
      };
      const canonical = migrateLegacy090Document(input);
      for (const key of Object.values(workflowMappings.contracts[input.dtype].fields)) {
        if (Object.hasOwn(fixture.document, key)) {
          const field = schema.$defs[documentTypes[input.dtype]].properties[key];
          expect(semanticValue(canonical[key], field)).toEqual(
            semanticValue(fixture.document[key], field)
          );
        }
      }
      expect(canonical).not.toHaveProperty("data");
      expect(canonical.extensions?.quasarLegacy090?.data).toBeUndefined();
      expect(toLegacyUiDocument(canonical).data).toEqual(fixture.legacyData);
    });
  }
  it("keeps envelope validity separate from content validity and preserves opaque keys", () => {
    const original = fixtures.find(
      (item) => item.valid && item.document.dtype === "research-node"
    ).document;
    const projected = toLegacyUiDocument(original);
    const restored = migrateLegacy090Document(projected);
    expect(restored.validFrom).toBe(original.validFrom);
    expect(restored.contentValidFrom).toBe(original.contentValidFrom);
    expect(restored.nodeCreatedAt).toBe(original.nodeCreatedAt);
    expect(restored.actorSelectionRules).toEqual(original.actorSelectionRules);
  });
  it("rejects duplicate manifest map keys rather than overwriting an entry", () => {
    expect(() =>
      toLegacyUiDocument({
        id: "manifest:x",
        dataset: "test",
        dtype: "dataset-manifest",
        schemaVersion: "0.10.1",
        countsByDtype: [
          { key: "person", value: 1 },
          { key: "person", value: 2 }
        ]
      })
    ).toThrow(/duplicate original map key/);
  });
});

it("does not overwrite an existing metadata extension when projecting envelope fields", () => {
  const document = {
    id: "event:metadata",
    dataset: "test",
    dtype: "event",
    schemaVersion: "0.10.1",
    validFrom: 123,
    name: "Example",
    extensions: { quasarCanonicalMetadata: { original_key: "keep" } }
  };
  const before = JSON.stringify(document);
  const restored = migrateLegacy090Document(toLegacyUiDocument(document));
  expect(restored).toEqual(document);
  expect(JSON.stringify(document)).toBe(before);
});
