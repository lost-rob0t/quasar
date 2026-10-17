import { fromPouchDocument, toPouchDocument, toCanonicalDocument } from "../lib/canonical-document";
import { chunkTransactionOperations } from "./transaction-chunks";
import { withMutationBase } from "./mutation-base";
import { withWorkspaceScope } from "./workspace-scope";

export async function walkProjection(database, visit, check = () => {}) {
  let cursor;
  for (;;) {
    check();
    const page = await database.allDocs({
      include_docs: true,
      limit: 51,
      ...(cursor === undefined ? {} : { startkey: cursor })
    });
    check();
    const rows = page.rows.filter((row) => row.id !== cursor);
    if (!rows.length) return;
    await visit(
      rows.filter((row) => row.doc && !row.id.startsWith("_design/")).map((row) => row.doc)
    );
    cursor = rows.at(-1).id;
  }
}
const assertWrites = (results) => {
  const failed = results.find((row) => row.error);
  if (failed) throw new Error(failed.message || failed.reason || "Projection write failed.");
};

/** Stage a complete revision on disk before reconciling the replication projection. */
export function synchronizeProjection(client, database, createStage) {
  return withWorkspaceScope(client, async (check) => {
    const stage = createStage();
    try {
      const result = await client.exportDocuments({
        write: async (document) => {
          check();
          const staged = toPouchDocument(document);
          delete staged._rev;
          await stage.put(staged);
        },
        close: async () => {},
        abort: async () => {}
      });
      check();
      await walkProjection(
        database,
        async (documents) => {
          const staged = await stage.allDocs({
            keys: documents.map((doc) => doc._id),
            include_docs: true
          });
          check();
          const byId = new Map(
            staged.rows.filter((row) => row.doc).map((row) => [row.id, row.doc])
          );
          const writes = documents.map((old) => {
            const next = byId.get(old._id);
            return next
              ? { ...next, _rev: old._rev }
              : { _id: old._id, _rev: old._rev, _deleted: true };
          });
          if (writes.length) assertWrites(await database.bulkDocs(writes));
        },
        check
      );
      await walkProjection(
        stage,
        async (documents) => {
          const current = await database.allDocs({ keys: documents.map((doc) => doc._id) });
          check();
          const present = new Set(
            current.rows.filter((row) => !row.error && !row.value?.deleted).map((row) => row.id)
          );
          const missing = documents
            .filter((doc) => !present.has(doc._id))
            .map((doc) => {
              const next = { ...doc };
              const tombstone = current.rows.find(
                (row) => row.id === doc._id && row.value?.deleted
              );
              if (tombstone) next._rev = tombstone.value.rev;
              else delete next._rev;
              return next;
            });
          if (missing.length) assertWrites(await database.bulkDocs(missing));
        },
        check
      );
      return result;
    } finally {
      await stage.destroy();
    }
  });
}

export function importProjection(client, database) {
  return withWorkspaceScope(client, async (check) => {
    const { revision } = await client.send("workspace.bootstrap", {});
    check();
    const started = await client.send("document.import.begin", {});
    const sessionId = started.sessionId;
    if (!sessionId) throw new Error("Import session ID is missing.");
    let sequence = 0,
      count = 0;
    try {
      check();
      await walkProjection(
        database,
        async (documents) => {
          for (let offset = 0; offset < documents.length; offset += 25) {
            const canonical = documents
              .slice(offset, offset + 25)
              .map((document) =>
                toCanonicalDocument(fromPouchDocument(document), { allowLegacy090: true })
              );
            const ids = await withMutationBase(
              client,
              canonical.map((doc) => doc.id),
              async (base) => {
                check();
                if (base.revision !== revision)
                  throw new Error("Workspace changed during projection import.");
                return new Set(base.documents.keys());
              }
            );
            const operations = canonical.map((doc) => ({
              type: ids.has(doc.id) ? "document.update" : "document.create",
              payload: doc
            }));
            for (const chunk of chunkTransactionOperations(operations)) {
              check();
              await client.send("document.import.chunk", {
                sessionId,
                sequence: sequence++,
                operations: chunk
              });
            }
            count += canonical.length;
          }
        },
        check
      );
      check();
      const result = await client.send("document.import.commit", { sessionId });
      check();
      return { ...result, count };
    } catch (error) {
      try {
        await client.send("document.import.abort", { sessionId });
      } catch {}
      throw error;
    }
  });
}
