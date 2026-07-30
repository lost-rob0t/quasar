import { describe, expect, it } from "vitest";
import { commitDocumentBatch, validateDocumentBatch } from "./document-batch";

const stamp = "2026-07-25T20:00:00.000Z";
const canonicalDocument = (id) => ({
  _id: id,
  dataset: "test",
  dtype: "org",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: id,
  sources: [],
  evidence: [],
  data: { name: id }
});

class FakeDatabase {
  constructor({ failWrites = [], failRollbacks = [], throwWrite = false } = {}) {
    this.documents = new Map();
    this.failWrites = new Set(failWrites);
    this.failRollbacks = new Set(failRollbacks);
    this.throwWrite = throwWrite;
    this.bulkCalls = 0;
  }

  async allDocs({ keys }) {
    return {
      rows: keys.map((id) => {
        const doc = this.documents.get(id);
        return doc ? { id, doc: { ...doc } } : { id, error: "not_found" };
      })
    };
  }

  async bulkDocs(documents) {
    this.bulkCalls += 1;
    if (this.throwWrite && this.bulkCalls === 1) throw new Error("database unavailable");
    return documents.map((document) => {
      const rollback = document._deleted || (document._rev && this.bulkCalls > 1);
      if ((rollback ? this.failRollbacks : this.failWrites).has(document._id)) {
        return { id: document._id, error: "conflict", message: "simulated conflict" };
      }
      const revision = `${this.bulkCalls}-${document._id}`;
      if (document._deleted) this.documents.delete(document._id);
      else this.documents.set(document._id, { ...document, _rev: revision });
      return { id: document._id, ok: true, rev: revision };
    });
  }
}

describe("atomic document batches", () => {
  it("rejects mixed valid and invalid documents before touching the database", async () => {
    const database = new FakeDatabase();
    const valid = canonicalDocument("starintel:org:valid");
    const report = await commitDocumentBatch(
      database,
      [valid, { _id: "invalid", dtype: "not-a-real-dtype" }],
      {
        origins: [
          { file: "records.json", record: 1 },
          { file: "records.json", record: 2 }
        ]
      }
    );

    expect(report.saved).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ file: "records.json", record: 2, id: "invalid" });
    expect(report.errors[0].validation[0]).toMatchObject({ path: "/dtype", keyword: "enum" });
    expect(database.bulkCalls).toBe(0);
    expect(database.documents.size).toBe(0);

    const retry = await commitDocumentBatch(database, [
      valid,
      canonicalDocument("starintel:org:fixed")
    ]);
    expect(retry.saved.map((item) => item.id)).toEqual([valid._id, "starintel:org:fixed"]);
    expect(retry.skipped).toEqual([]);
  });

  it("rejects duplicate IDs during preflight", () => {
    const duplicate = canonicalDocument("starintel:org:duplicate");
    const report = validateDocumentBatch([duplicate, { ...duplicate }]);

    expect(report.validated).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      id: duplicate._id,
      validation: [{ path: "/_id", keyword: "unique" }]
    });
  });

  it("reports committed and rejected records separately in explicit partial mode", async () => {
    const database = new FakeDatabase();
    const valid = canonicalDocument("starintel:org:partial-valid");
    const report = await commitDocumentBatch(
      database,
      [valid, { _id: "invalid", dtype: "not-a-real-dtype" }],
      { atomic: false }
    );

    expect(report.saved.map((item) => item.id)).toEqual([valid._id]);
    expect(report.errors).toHaveLength(1);
    expect(database.documents.has(valid._id)).toBe(true);
  });

  it("rolls back successful writes when another PouchDB result fails", async () => {
    const failedId = "starintel:org:failed";
    const database = new FakeDatabase({ failWrites: [failedId] });
    const report = await commitDocumentBatch(database, [
      canonicalDocument("starintel:org:saved-then-rolled-back"),
      canonicalDocument(failedId)
    ]);

    expect(report.saved).toEqual([]);
    expect(report.rolledBack).toBe(1);
    expect(report.errors[0]).toMatchObject({ id: failedId, phase: "write" });
    expect(database.documents.size).toBe(0);
  });

  it("throws a repair-required error when compensating rollback fails", async () => {
    const survivorId = "starintel:org:survivor";
    const failedId = "starintel:org:failed";
    const database = new FakeDatabase({
      failWrites: [failedId],
      failRollbacks: [survivorId]
    });

    await expect(
      commitDocumentBatch(database, [canonicalDocument(survivorId), canonicalDocument(failedId)])
    ).rejects.toMatchObject({
      code: "PARTIAL_BATCH_COMMIT",
      report: {
        saved: [{ index: 0, id: survivorId, rev: `1-${survivorId}` }],
        rollbackAttempted: true
      }
    });

    expect(database.documents.has(survivorId)).toBe(true);
  });

  it("reports a thrown storage failure without claiming any committed IDs", async () => {
    const database = new FakeDatabase({ throwWrite: true });
    const report = await commitDocumentBatch(database, [
      canonicalDocument("starintel:org:a"),
      canonicalDocument("starintel:org:b")
    ]);

    expect(report.saved).toEqual([]);
    expect(report.errors).toHaveLength(2);
    expect(report.errors.every((error) => error.phase === "write")).toBe(true);
  });
});
