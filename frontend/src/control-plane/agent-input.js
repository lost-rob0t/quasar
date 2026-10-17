import { linkedDocumentIds, actorTouchedDocumentIds } from "../lib/run-all-transformations";
import { toLegacyUiDocument } from "../lib/canonical-document";
import { buildAgentContext } from "../lib/agent-context";
import { withWorkspaceScope } from "./workspace-scope";

/** Explicit operator/agent actions may scan, but never retain a workspace corpus. */
export function queryCanonicalDocuments(
  client,
  predicate,
  limit,
  { requireComplete = false } = {}
) {
  return withWorkspaceScope(client, async (check) => {
    const documents = [];
    let bytes = 0;
    const stop = new Error("bounded-query-complete");
    let revision;
    try {
      const result = await client.exportDocuments({
        async write(canonical) {
          check();
          const document = toLegacyUiDocument(canonical);
          if (!predicate(document)) return;
          if (documents.length >= limit) {
            if (requireComplete)
              throw new Error("The operation exceeds its document budget. Narrow its scope.");
            throw stop;
          }
          bytes += new TextEncoder().encode(JSON.stringify(document)).byteLength;
          if (bytes > 8388608) throw new Error("The operation exceeds its 8 MiB input budget.");
          documents.push(document);
          if (!requireComplete && documents.length === limit) throw stop;
        },
        close: async () => {},
        abort: async () => {}
      });
      revision = result.revision;
    } catch (error) {
      if (error !== stop) throw error;
    }
    check();
    return { documents, revision };
  });
}

export async function canonicalAgentContext(client, input) {
  const selected = new Set(input.selectionIds || []),
    targets = new Set(input.targetIds || []);
  const buckets = [[], [], []];
  let candidates = 0,
    relations = 0,
    bytes = 0;
  const result = await client.exportDocuments({
    async write(canonical) {
      const document = toLegacyUiDocument(canonical);
      const priority = selected.has(document._id) ? 0 : targets.has(document._id) ? 1 : 2;
      if (
        priority === 2 &&
        !targets.has(document.data?.target_id) &&
        !(input.dataset && document.dataset === input.dataset && document.dtype === "relation")
      )
        return;
      candidates += 1;
      if (document.dtype === "relation") relations += 1;
      if (buckets[priority].length < 30) {
        bytes += new TextEncoder().encode(JSON.stringify(document)).byteLength;
        if (bytes > 8388608) throw new Error("Agent context exceeds its input byte budget.");
        buckets[priority].push(document);
      }
    },
    close: async () => {},
    abort: async () => {}
  });
  const context = buildAgentContext({ ...input, documents: buckets.flat() });
  context.limits.candidateDocuments = candidates;
  context.limits.candidateRelations = relations;
  context.limits.truncated = candidates > context.limits.includedDocuments;
  context.revision = result.revision;
  return context;
}

export function agentOperationBase(client, operations) {
  const ids = new Set(),
    merged = new Set();
  for (const op of operations || []) {
    for (const id of [
      op.id,
      op.primaryId,
      op.document?._id,
      ...(op.mergeIds || []),
      ...(op.documents || []).map((doc) => doc._id)
    ])
      if (id) ids.add(id);
    if (op.op === "merge_nodes") (op.mergeIds || []).forEach((id) => merged.add(id));
  }
  const referenced = (value) =>
    typeof value === "string"
      ? merged.has(value)
      : Array.isArray(value)
        ? value.some(referenced)
        : value &&
          typeof value === "object" &&
          [value.id, value.entity_id, value.document_id].some((id) => merged.has(id));
  return queryCanonicalDocuments(
    client,
    (document) =>
      ids.has(document._id) ||
      (document.dtype === "relation" &&
        [
          document.data?.subject,
          document.data?.source,
          document.data?.object,
          document.data?.target
        ].some(referenced)),
    1000,
    { requireComplete: true }
  );
}

/** Retain two bounded ID sets, even if unrelated actor outputs span the corpus. */
export async function transformationEvidence(client, scopeIds, actorId) {
  const scope = new Set(scopeIds);
  if (scope.size > 2000) throw new Error("Transformation scope exceeds graph limits.");
  const linked = new Set(),
    touched = new Set();
  await client.exportDocuments({
    async write(canonical) {
      const document = toLegacyUiDocument(canonical);
      for (const id of linkedDocumentIds([document])) if (scope.has(id)) linked.add(id);
      for (const id of actorTouchedDocumentIds([document], actorId))
        if (scope.has(id)) touched.add(id);
    },
    close: async () => {},
    abort: async () => {}
  });
  return { linked, touched };
}
