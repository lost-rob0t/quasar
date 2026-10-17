import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { synchronizeProjection } from "../../src/control-plane/projection-sync";
import { fromPouchDocument, toPouchDocument } from "../../src/lib/canonical-document";

globalThis.self = globalThis;
const { default: PouchDB } = await import("pouchdb-browser");

const databases = [];
const database = (track = true) => {
  const db = new PouchDB(`projection-test-${crypto.randomUUID()}`);
  if (track) databases.push(db);
  return db;
};
const document = (id, name = id) => ({
  id,
  dtype: "entity",
  dataset: "test",
  schemaVersion: "0.10.1",
  name
});
const client = (documents, interrupt = false) => ({
  onConnectionStateChange: () => () => {},
  exportDocuments: async (sink) => {
    for (const item of documents) await sink.write(item);
    if (interrupt) throw new Error("interrupted export");
    return { revision: 1 };
  }
});
const project = (documents, destination, interrupt = false) =>
  synchronizeProjection(client(documents, interrupt), destination, () => database(false));
const reopen = async (db) => {
  await db.close();
  const opened = new PouchDB(db.name);
  databases[databases.indexOf(db)] = opened;
  return opened;
};

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

it("accepts a pulled PouchDB revision during the following push", async () => {
  const remote = database();
  const local = database();
  await remote.put(toPouchDocument(document("pulled")));
  await local.replicate.from(remote);
  const pulled = fromPouchDocument(await local.get("pulled"));
  expect(pulled.rev).toMatch(/^1-/);

  await local.put({ ...(await local.get("pulled")), name: "local edit" });
  await project([{ ...pulled, name: "canonical" }], local);
  expect((await local.get("pulled")).id).toBe("pulled");
  expect((await local.get("pulled")).name).toBe("canonical");
  expect((await local.get("pulled"))._rev).toMatch(/^3-/);
  await local.replicate.to(remote);
  expect((await remote.get("pulled")).name).toBe("canonical");
});

it("reconciles both directions and repeats without losing canonical identity", async () => {
  const remote = database();
  const local = database();
  await remote.put(toPouchDocument(document("remote")));
  await local.put(toPouchDocument(document("local")));
  await local.sync(remote);
  const canonical = ["local", "remote"].map(async (id) => fromPouchDocument(await local.get(id)));
  const exported = await Promise.all(canonical);
  await project(exported, local);
  await project(exported, local);
  await local.sync(remote);
  expect((await remote.allDocs()).rows.map((row) => row.id)).toEqual(["local", "remote"]);
  for (const id of ["local", "remote"]) {
    const stored = await local.get(id);
    expect(stored.id).toBe(id);
    expect(stored._rev).toMatch(/^\d+-/);
  }
});

it("leaves the destination durable on interruption and recovers on retry", async () => {
  let local = database();
  await local.put(toPouchDocument(document("old")));
  await expect(project([document("new")], local, true)).rejects.toThrow("interrupted export");
  local = await reopen(local);
  expect((await local.allDocs()).rows.map((row) => row.id)).toEqual(["old"]);
  await project([document("new")], local);
  local = await reopen(local);
  expect((await local.allDocs()).rows.map((row) => row.id)).toEqual(["new"]);
  expect((await local.get("new")).id).toBe("new");
});

it("uses a destination tombstone revision when restoring a canonical record", async () => {
  const local = database();
  const original = await local.put(toPouchDocument(document("restored")));
  await local.remove("restored", original.rev);
  await project([document("restored")], local);
  expect((await local.get("restored")).id).toBe("restored");
});

it("reports a concurrent destination write as a conflict", async () => {
  const local = database();
  await local.put(toPouchDocument(document("shared", "original")));
  const destination = {
    allDocs: (...args) => local.allDocs(...args),
    bulkDocs: async (documents) => {
      const current = await local.get("shared");
      await local.put({ ...current, name: "concurrent" });
      return local.bulkDocs(documents);
    }
  };
  await expect(project([document("shared", "desired")], destination)).rejects.toThrow();
  expect((await local.get("shared")).name).toBe("concurrent");
});
