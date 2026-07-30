import { describe, expect, it, vi } from "vitest";
import { collectImportDocuments, documentsToJsonl, importFiles } from "./importer";
import { validateDocumentBatch } from "./document-batch";

function file(name, text) {
  return { name, size: text.length, text: async () => text };
}

const stamp = "2026-07-25T20:00:00.000Z";
const document = {
  _id: "starintel:org:test",
  dataset: "test",
  dtype: "org",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  sources: [],
  evidence: [],
  data: { name: "Test" }
};

const relation = {
  ...document,
  _id: "starintel:relation:subsidiary",
  dtype: "relation",
  data: {
    subject: "starintel:org:subsidiary",
    predicate: "subsidiary-of",
    object: "starintel:org:parent",
    source: "starintel:org:subsidiary",
    target: "starintel:org:parent",
    directed: true,
    inverse_predicate: "parent-of",
    confidence: 0.7,
    active: true,
    note: "Imported from Parent Company column."
  }
};

async function validateAndSave(candidates, options) {
  const preflight = validateDocumentBatch(candidates, { origins: options.origins });
  return {
    saved: preflight.validated.map(({ index, document: candidate }) => ({
      index,
      id: candidate._id,
      rev: `1-${index}`
    })),
    skipped: [],
    errors: preflight.errors
  };
}

describe("browser imports", () => {
  it("parses JSONL", async () => {
    const result = await collectImportDocuments([
      file("records.jsonl", `${JSON.stringify(document)}\n`)
    ]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]._id).toBe(document._id);
    expect(result.origins[0]).toEqual({ file: "records.jsonl", line: 1, record: 1 });
  });

  it("parses JSON, NDJSON, and CSV with stable source locations", async () => {
    const json = await collectImportDocuments([file("records.json", JSON.stringify([document]))]);
    const ndjson = await collectImportDocuments([
      file("records.ndjson", `${JSON.stringify(document)}\n`)
    ]);
    const csv = await collectImportDocuments([
      file(
        "records.csv",
        `_id,dataset,dtype,title,data\n${document._id},test,org,Test,"{""name"":""Test""}"\n`
      )
    ]);

    expect(json.origins[0]).toEqual({ file: "records.json", record: 1 });
    expect(ndjson.origins[0]).toEqual({ file: "records.ndjson", line: 1, record: 1 });
    expect(csv.documents[0]._id).toBe(document._id);
    expect(csv.origins[0]).toEqual({ file: "records.csv", line: 2, record: 1 });
  });

  it("resolves files named by a dataset manifest", async () => {
    const manifest = {
      ...document,
      _id: "starintel:dataset-manifest:test",
      dtype: "dataset-manifest",
      data: { manifest_type: "dataset", name: "test", files: [{ path: "records.jsonl" }] }
    };
    const result = await collectImportDocuments(
      [
        file("manifest.json", JSON.stringify(manifest)),
        file("records.jsonl", `${JSON.stringify(document)}\n`)
      ],
      { resolveManifestReferences: true }
    );
    expect(result.documents.map((item) => item._id)).toContain(manifest._id);
    expect(result.documents.map((item) => item._id)).toContain(document._id);
    expect(result.errors).toHaveLength(0);
  });

  it("imports manifest documents inside a corpus without treating them as bundle instructions", async () => {
    const manifest = {
      ...document,
      _id: "starintel:dataset-manifest:archived-packet",
      dtype: "dataset-manifest",
      data: {
        manifest_type: "dataset",
        name: "Archived packet",
        files: [{ path: "full-oldb.LATEST.zip" }, { path: "README.md" }]
      }
    };
    const result = await collectImportDocuments([
      file(
        "starintel-complete-corpus.jsonl",
        `${JSON.stringify(manifest)}\n${JSON.stringify(document)}\n`
      )
    ]);

    expect(result.documents.map((item) => item._id)).toEqual([manifest._id, document._id]);
    expect(result.errors).toEqual([]);
  });

  it("reports missing manifest files only in explicit bundle mode", async () => {
    const manifest = {
      ...document,
      _id: "starintel:dataset-manifest:bundle",
      dtype: "dataset-manifest",
      data: {
        manifest_type: "dataset",
        name: "Bundle",
        files: [{ path: "records.jsonl" }, { path: "README.md" }]
      }
    };
    const result = await collectImportDocuments(
      [
        file("manifest.json", JSON.stringify(manifest)),
        file("records.jsonl", `${JSON.stringify(document)}\n`)
      ],
      { resolveManifestReferences: true }
    );

    expect(result.errors).toEqual([
      { file: "manifest.json", message: "manifest reference not supplied: README.md" }
    ]);
  });

  it("exports canonical JSONL with a terminating newline", () => {
    const output = documentsToJsonl([document]);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output.trim())._id).toBe(document._id);
  });

  it("rejects an atomic import before saving when any line fails to parse", async () => {
    const saveBatch = vi.fn();
    const promise = importFiles(
      [file("records.jsonl", `${JSON.stringify(document)}\n{not-json}\n`)],
      saveBatch
    );

    await expect(promise).rejects.toMatchObject({
      report: {
        saved: [],
        parseErrors: [{ file: "records.jsonl", line: 2 }]
      }
    });
    expect(saveBatch).not.toHaveBeenCalled();
  });

  it("returns stable imported IDs from the committed batch", async () => {
    const saveBatch = vi.fn().mockResolvedValue({
      saved: [{ index: 0, id: document._id, rev: "1-a" }],
      skipped: [],
      errors: []
    });
    const result = await importFiles([file("records.json", JSON.stringify(document))], saveBatch);

    expect(result.importedIds).toEqual([document._id]);
    expect(saveBatch.mock.calls[0][1].origins).toEqual([{ file: "records.json", record: 1 }]);
  });

  it("accepts the canonical relation shape rejected by the stale deployed validator", async () => {
    const result = await importFiles(
      [file("relation.json", JSON.stringify(relation))],
      validateAndSave
    );

    expect(result.errors).toEqual([]);
    expect(result.importedIds).toEqual([relation._id]);
    expect(result.validator).toMatchObject({
      schemaVersion: "0.9.0",
      profile: "starintel-core"
    });
  });

  it("validates endpoint and relation records together in one JSONL batch", async () => {
    const endpointA = { ...document, _id: relation.data.subject, data: { name: "Subsidiary" } };
    const endpointB = { ...document, _id: relation.data.object, data: { name: "Parent" } };
    const reverseRelation = {
      ...relation,
      _id: "starintel:relation:parent",
      data: {
        ...relation.data,
        subject: endpointB._id,
        predicate: "parent-of",
        object: endpointA._id,
        inverse_predicate: "subsidiary-of"
      }
    };
    const records = [endpointA, endpointB, relation, reverseRelation];
    const result = await importFiles(
      [file("relations.jsonl", `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)],
      validateAndSave
    );

    expect(result.errors).toEqual([]);
    expect(result.saved).toHaveLength(4);
    expect(result.importedIds).toEqual(records.map((record) => record._id));
  });
});
