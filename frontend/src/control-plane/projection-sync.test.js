import { expect, it, vi } from "vitest";
import { synchronizeProjection, walkProjection } from "./projection-sync";
function database(initial = []) {
  const records = new Map(initial.map((doc) => [doc._id, { ...doc }]));
  return {
    records,
    allDocs: vi.fn(async (options) => ({
      rows: (
        options.keys ||
        [...records.keys()]
          .sort()
          .filter((id) => !options.startkey || id >= options.startkey)
          .filter((id) => !records.get(id)._deleted)
          .slice(0, options.limit)
      ).map((id) => {
        const doc = records.get(id);
        return doc
          ? {
              id,
              value: { rev: doc._rev, deleted: doc._deleted },
              ...(options.include_docs && !doc._deleted ? { doc: { ...doc } } : {})
            }
          : { key: id, error: "not_found" };
      })
    })),
    put: vi.fn(async (doc) => {
      records.set(doc._id, { ...doc, _rev: "1-stage" });
    }),
    bulkDocs: vi.fn(async (docs) =>
      docs.map((doc) => {
        const old = records.get(doc._id);
        if (old && old._rev !== doc._rev) return { error: "conflict" };
        records.set(doc._id, { ...doc, _rev: "2-current" });
        return { ok: true };
      })
    ),
    destroy: vi.fn(async () => {})
  };
}
const canonical = (id) => ({
  id,
  dtype: "entity",
  dataset: "test",
  schemaVersion: "0.10.1",
  name: id
});
const client = (docs, fail = false) => ({
  onConnectionStateChange: () => () => {},
  exportDocuments: async (sink) => {
    for (const doc of docs) await sink.write(doc);
    if (fail) throw new Error("stale revision");
    await sink.close();
    return { revision: 4 };
  }
});
it("pages through deleted cursor rows without skipping the next live row", async () => {
  const db = database(
    Array.from({ length: 130 }, (_, i) => ({ _id: String(i).padStart(3, "0"), _rev: "1" }))
  );
  const seen = [];
  await walkProjection(db, async (docs) => {
    seen.push(...docs.map((doc) => doc._id));
    await db.bulkDocs(docs.map((doc) => ({ ...doc, _deleted: true })));
  });
  expect(seen).toHaveLength(130);
  expect(new Set(seen).size).toBe(130);
  expect(db.allDocs.mock.calls.every(([options]) => options.limit === 51)).toBe(true);
});
it("does not alter the replication database until a complete export succeeds", async () => {
  const db = database([{ _id: "old", _rev: "1" }]),
    stage = database();
  await expect(
    synchronizeProjection(client([canonical("new")], true), db, () => stage)
  ).rejects.toThrow("stale revision");
  expect(db.bulkDocs).not.toHaveBeenCalled();
  expect(stage.destroy).toHaveBeenCalledOnce();
});
it("resurrects a canonical record over a deleted local tombstone and removes stale records", async () => {
  const db = database([
      { _id: "back", _rev: "1-deleted", _deleted: true },
      { _id: "old", _rev: "1" }
    ]),
    stage = database();
  await synchronizeProjection(client([canonical("back")]), db, () => stage);
  expect(db.records.get("back")._deleted).not.toBe(true);
  expect(db.records.get("old")._deleted).toBe(true);
  expect(stage.destroy).toHaveBeenCalledOnce();
});
