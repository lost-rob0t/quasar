import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

/** Capture only the edited record for undo, then commit against that exact revision. */
export async function commitDocumentEdit(
  client: Pick<ControlPlaneClient, "send" | "transaction" | "onConnectionStateChange">,
  id: string,
  document?: Record<string, unknown>
) {
  if (!id || id.length > 512 || (document && (document.id || document._id) !== id)) {
    throw new ControlPlaneError("query.invalid", "Document edit requires a matching canonical ID.");
  }
  let valid = true;
  const unsubscribe = client.onConnectionStateChange((state) => {
    if (!state.synchronized) valid = false;
  });
  const check = () => {
    if (!valid) throw new ControlPlaneError("query.cancelled", "Document edit scope changed.");
  };
  try {
    check();
    const bootstrap = await client.send<{ revision: number }>("workspace.bootstrap", {});
    check();
    if (!Number.isSafeInteger(bootstrap.revision) || bootstrap.revision < 0)
      throw new ControlPlaneError("protocol.invalid-envelope", "Invalid edit revision.");
    const batch = await client.send<{
      revision: number;
      documents: Record<string, unknown>[];
      missingIds: string[];
    }>("document.batch", {
      ids: [id],
      expectedRevision: bootstrap.revision,
      byteLimit: 524288
    });
    check();
    if (batch.revision !== bootstrap.revision)
      throw new ControlPlaneError("query.stale-cursor", "Document changed before editing.");
    if (
      !Array.isArray(batch.documents) ||
      !Array.isArray(batch.missingIds) ||
      !(
        (batch.documents.length === 1 &&
          batch.documents[0]?.id === id &&
          batch.documents[0]?.schemaVersion === "0.10.1" &&
          batch.missingIds.length === 0) ||
        (batch.documents.length === 0 &&
          batch.missingIds.length === 1 &&
          batch.missingIds[0] === id)
      )
    )
      throw new ControlPlaneError(
        "protocol.invalid-envelope",
        "Edit lookup must explicitly report the document or its absence."
      );
    const previous = batch.documents[0] ?? null;
    const type = document ? (previous ? "document.update" : "document.create") : "document.delete";
    const transaction = (await client.transaction(
      [{ type, payload: document ?? { id } }],
      bootstrap.revision
    )) as { results: unknown[] };
    // A committed result is returned even if navigation occurs while waiting for
    // the acknowledgement. Never retry a potentially committed mutation here.
    return { result: transaction.results[0], previous };
  } finally {
    unsubscribe();
  }
}
