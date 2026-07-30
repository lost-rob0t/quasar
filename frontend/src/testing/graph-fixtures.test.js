import { describe, expect, it } from "vitest";
import { validateDocumentBatch } from "../lib/document-batch";
import { buildGraph } from "../lib/graph";
import { normalizeGraphWorkspace } from "../lib/graph-workspaces";
import { collectImportDocuments, documentsToJsonl } from "../lib/importer";
import {
  FIXTURE_SCHEMA_VERSION,
  blankGraphFixture,
  cloneFixture,
  fixtureFiles,
  fixtureManifest,
  highDegreeGraphFixture,
  invalidDocumentFixtures,
  legacyWorkspaceFixture,
  operationFixtures,
  performanceGraphFixture,
  smallTypedGraphFixture,
  stableSerialize,
  unknownTypeGraphFixture
} from "./graph-fixtures";

function file(name, text) {
  return { name, size: text.length, text: async () => text };
}

describe("deterministic graph fixtures", () => {
  it("versions fixtures and returns independent copies", () => {
    const first = smallTypedGraphFixture();
    const second = smallTypedGraphFixture();

    expect(first.fixtureVersion).toBe(FIXTURE_SCHEMA_VERSION);
    expect(stableSerialize(first)).toBe(stableSerialize(second));
    first.documents[0].data.full_name = "Changed";
    expect(second.documents[0].data.full_name).toBe("Ada Lovelace");
    expect(cloneFixture(second)).toEqual(second);
    expect(fixtureManifest.performanceNodeCounts).toEqual([100, 10000]);
  });

  it("provides blank, typed, high-degree, and valid schema cases", () => {
    expect(blankGraphFixture().documents).toEqual([]);

    const typed = smallTypedGraphFixture();
    const validation = validateDocumentBatch(typed.documents);
    expect(validation.errors).toEqual([]);
    expect(new Set(typed.documents.map((document) => document.dataset)).size).toBeGreaterThan(1);

    const highDegree = highDegreeGraphFixture(12);
    const graph = buildGraph(highDegree.documents);
    expect(graph.nodes).toHaveLength(highDegree.expected.nodes);
    expect(graph.edges).toHaveLength(highDegree.expected.edges);
    expect(graph.edges.filter((edge) => edge.data.source === "starintel:org:hub")).toHaveLength(12);
  });

  it("keeps invalid documents as stable negative conformance cases", () => {
    const invalid = invalidDocumentFixtures();
    const validation = validateDocumentBatch(invalid.map((item) => item.document));

    expect(invalid.map((item) => item.name)).toEqual(["unknown-dtype", "missing-relation-object"]);
    expect(validation.validated).toHaveLength(0);
    expect(validation.errors).toHaveLength(2);
  });

  it("preserves unknown types and extension fields through JSON and JSONL", () => {
    const fixture = unknownTypeGraphFixture();
    const fromJson = JSON.parse(stableSerialize(fixture));
    const fromJsonl = JSON.parse(documentsToJsonl(fixture.documents).trim());
    const graph = buildGraph(fromJson.documents);

    expect(fromJson.documents[0].fixture_extension).toBe("preserve-me");
    expect(fromJsonl.data.extension_value).toEqual({ nested: true });
    expect(graph.nodes[0].data.dtype).toBe("future-entity");
  });

  it("migrates legacy workspace state without losing graph state", () => {
    const legacy = legacyWorkspaceFixture();
    const migrated = normalizeGraphWorkspace(legacy);

    expect(migrated.graphs).toHaveLength(1);
    expect(migrated.activeGraphId).toBe("all-documents");
    expect(migrated.positions).toEqual(legacy.positions);
    expect(migrated.viewport).toEqual(legacy.viewport);
    expect(migrated.layout).toBe("grid");
  });

  it("covers supported serialized formats and malformed input", async () => {
    const files = fixtureFiles();
    const parsedJson = await collectImportDocuments([file("fixture.json", files.json)]);
    const parsedJsonl = await collectImportDocuments([file("fixture.jsonl", files.jsonl)]);
    const parsedNdjson = await collectImportDocuments([file("fixture.ndjson", files.jsonl)]);
    const parsedCsv = await collectImportDocuments([file("fixture.csv", files.csv)]);
    const badJson = await collectImportDocuments([file("invalid.json", files.invalidJson)]);
    const badJsonl = await collectImportDocuments([file("invalid.jsonl", files.invalidJsonl)]);
    const badCsv = await collectImportDocuments([file("invalid.csv", files.invalidCsv)]);

    expect(parsedJson.documents).toHaveLength(5);
    expect(parsedJsonl.documents).toEqual(parsedNdjson.documents);
    expect(parsedJsonl.errors).toEqual([]);
    expect(parsedCsv.documents[0]).toMatchObject({
      _id: "starintel:person:ada",
      data: { full_name: "Ada Lovelace" }
    });
    expect(badJson.errors).toHaveLength(1);
    expect(badJsonl.errors).toHaveLength(1);
    expect(badCsv.errors).toHaveLength(1);
  });

  it("models commands, batches, import/export, and revision traces", () => {
    const fixtures = operationFixtures();

    expect(fixtures.command.type).toBe("save-document");
    expect(fixtures.batch.operations.map((item) => item.type)).toEqual([
      "save-document",
      "remove-document"
    ]);
    expect(fixtures.import.atomic).toBe(true);
    expect(fixtures.export.format).toBe("jsonl");
    expect(fixtures.revisionTrace.map((entry) => entry.revision)).toEqual([
      "1-fixture",
      "2-fixture"
    ]);
  });

  it.each([100, 10000])("generates a deterministic %i-node performance fixture", (count) => {
    const fixture = performanceGraphFixture(count);

    expect(fixture.documents).toHaveLength(count);
    expect(fixture.documents[0]._id).toBe("starintel:org:performance-00000");
    expect(fixture.documents.at(-1).data.ordinal).toBe(count - 1);
    expect(stableSerialize(fixture.documents[0])).toBe(
      stableSerialize(performanceGraphFixture(count).documents[0])
    );
  });
});
