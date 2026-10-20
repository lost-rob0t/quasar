import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";
import { toLegacyUiDocument } from "../lib/canonical-document";
import { targetInputExpansionActor, relationsFromRelatedIdsActor } from "../lib/actors-core";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
export async function actorIdRecords(
  client: Pick<ControlPlaneClient, "send">,
  ids: string[],
  revision: number,
  check: () => void
) {
  const unique = [...new Set(ids)];
  if (unique.length > 4096) throw new Error("Actor input exceeds the ID budget.");
  const records: Doc[] = [];
  let bytes = 0;
  const read = async (batch: string[]): Promise<void> => {
    check();
    let result: Doc;
    try {
      result = await client.send<Doc>("document.batch", {
        ids: batch,
        expectedRevision: revision,
        byteLimit: 524288
      });
    } catch (error) {
      if (
        batch.length > 1 &&
        error instanceof ControlPlaneError &&
        ["query.record-too-large", "query.deadline"].includes(error.code)
      ) {
        const mid = Math.ceil(batch.length / 2);
        await read(batch.slice(0, mid));
        await read(batch.slice(mid));
        return;
      }
      throw error;
    }
    check();
    if (result.revision !== revision)
      throw new ControlPlaneError("query.stale-cursor", "Actor input revision changed.");
    if (
      !Array.isArray(result.documents) ||
      !Array.isArray(result.missingIds) ||
      new TextEncoder().encode(JSON.stringify(result)).byteLength > 524288
    )
      throw new Error("Invalid actor ID batch.");
    const outstanding = new Set(batch);
    for (const doc of result.documents) {
      if (!outstanding.delete(doc.id)) throw new Error("Unexpected actor input ID.");
      bytes += new TextEncoder().encode(JSON.stringify(doc)).byteLength;
      if (bytes > 8388608) throw new Error("Actor inputs exceed 8 MiB.");
      records.push(toLegacyUiDocument(doc));
    }
    for (const id of result.missingIds)
      if (!outstanding.delete(id)) throw new Error("Unexpected actor missing ID.");
    if (outstanding.size) throw new Error("Actor lookup omitted requested IDs.");
  };
  for (let offset = 0; offset < unique.length; offset += 50)
    await read(unique.slice(offset, offset + 50));
  return records;
}

/** Builtins keep their dedup/reference behavior using only IDs they can consult. */
export async function prepareActorInput(
  client: Pick<ControlPlaneClient, "send">,
  actor: Doc,
  requested: (string | Doc)[],
  check: () => void
) {
  const bootstrap = await client.send<{ revision: number }>("workspace.bootstrap", {});
  check();
  const revision = bootstrap.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid actor revision.");
  const ids = requested.map((item) => (typeof item === "string" ? item : item._id)).filter(Boolean);
  const known = new Map(
    (await actorIdRecords(client, ids, revision, check)).map((doc) => [doc._id, doc])
  );
  for (const item of requested)
    if (typeof item !== "string" && item?._id) known.set(item._id, item);
  const selection = ids.map((id) => known.get(id)).filter(Boolean) as Doc[];
  if (actor.id === "quasar.actor.target-input-expansion") {
    const references = new Set<string>();
    const visit = (value: unknown) => {
      if (typeof value === "string" && /^starintel:[^\s]+$/i.test(value)) references.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
      if (references.size > 1024) throw new Error("Target references exceed actor input limits.");
    };
    selection.forEach((doc) => visit(doc.data));
    for (const doc of await actorIdRecords(client, [...references], revision, check))
      known.set(doc._id, doc);
  }
  const context = { selection, documents: [...known.values()] };
  let candidateIds: string[] = [];
  if (actor.id === "quasar.actor.target-input-expansion")
    candidateIds = targetInputExpansionActor(context).documents.map((doc: Doc) => doc._id);
  if (actor.id === "quasar.actor.related-id-relations")
    candidateIds = relationsFromRelatedIdsActor(context).operations.map(
      (op: Doc) => op.document._id
    );
  for (const doc of await actorIdRecords(client, candidateIds, revision, check))
    known.set(doc._id, doc);
  return { selection, documents: [...known.values()], revision };
}
