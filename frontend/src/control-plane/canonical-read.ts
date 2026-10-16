import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

export async function readCanonicalDocument(
  client: Pick<ControlPlaneClient, "send" | "onConnectionStateChange">,
  id: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  if (!id || id.length > 512) throw new ControlPlaneError("query.invalid", "Invalid document ID.");
  let valid = true;
  const unsubscribe = client.onConnectionStateChange((state) => {
    if (!state.synchronized) valid = false;
  });
  const check = () => {
    if (!valid || signal?.aborted)
      throw new ControlPlaneError("query.cancelled", "Document lookup scope changed.");
  };
  try {
    check();
    const bootstrap = await client.send<{ revision: number }>("workspace.bootstrap", {});
    check();
    if (!Number.isSafeInteger(bootstrap.revision) || bootstrap.revision < 0)
      throw new ControlPlaneError("protocol.invalid-envelope", "Invalid document revision.");
    const result = await client.send<{
      revision: number;
      documents: Record<string, unknown>[];
      missingIds: string[];
    }>("document.batch", { ids: [id], expectedRevision: bootstrap.revision, byteLimit: 524288 });
    check();
    if (result.revision !== bootstrap.revision)
      throw new ControlPlaneError("query.stale-cursor", "Document lookup revision changed.");
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 524288)
      throw new ControlPlaneError("query.record-too-large", "Document exceeds inspection budget.");
    if (!Array.isArray(result.documents) || !Array.isArray(result.missingIds))
      throw new ControlPlaneError("protocol.invalid-envelope", "Invalid document batch.");
    if (
      result.documents.length === 0 &&
      result.missingIds.length === 1 &&
      result.missingIds[0] === id
    )
      return null;
    if (
      result.documents.length === 1 &&
      result.missingIds.length === 0 &&
      result.documents[0]?.id === id &&
      result.documents[0]?.schemaVersion === "0.10.1"
    )
      return result.documents[0];
    throw new ControlPlaneError(
      "protocol.invalid-envelope",
      "Document batch must explicitly report the requested ID or absence."
    );
  } finally {
    unsubscribe();
  }
}
