import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";
import { toLegacyUiDocument } from "../lib/canonical-document";
export type DocumentScope = { q: string; dtype: string; dataset: string };
export type CanonicalPage = {
  revision: number;
  documents: Record<string, unknown>[];
  complete: boolean;
  cursor: string | null;
};
export function matchesDocument(document: Record<string, unknown>, scope: DocumentScope) {
  if (scope.dtype && document.dtype !== scope.dtype) return false;
  if (scope.dataset && document.dataset !== scope.dataset) return false;
  if (!scope.q) return true;
  const row = toLegacyUiDocument(document);
  return `${row._id} ${row.dataset} ${row.dtype} ${row.title || ""} ${row.summary || ""} ${JSON.stringify(row.data)} ${JSON.stringify(row.sources || [])}`
    .toLowerCase()
    .includes(scope.q.toLowerCase());
}

/** Preserve nested legacy search semantics without retaining or draining a corpus. */
export async function readDocumentListPage(
  client: Pick<ControlPlaneClient, "send">,
  scope: DocumentScope,
  revision: number,
  cursor: string | null,
  limit: number,
  check: () => void
): Promise<CanonicalPage> {
  if (![25, 50, 100, 250].includes(limit)) throw new Error("Invalid document page size.");
  check();
  const capabilities = await client.send<unknown>("system.capabilities", {});
  check();
  if (!Array.isArray(capabilities) || !capabilities.includes("document.page"))
    throw new ControlPlaneError(
      "query.unsupported",
      "Server does not support canonical document pages."
    );
  const documents: Record<string, unknown>[] = [];
  let requests = 0;
  let scanned = 0,
    retainedBytes = 0;
  const started = Date.now();
  const encoder = new TextEncoder();
  for (;;) {
    check();
    const byteLimit = 524288 - retainedBytes;
    if (byteLimit < 32768) return { revision, documents, complete: false, cursor };
    requests += 1;
    const previous = cursor;
    let result: CanonicalPage;
    try {
      result = await client.send<CanonicalPage>("document.page", {
        limit: Math.min(50, limit - documents.length),
        byteLimit,
        ...(cursor === null ? {} : { cursor })
      });
    } catch (error) {
      check();
      if (
        documents.length &&
        error instanceof ControlPlaneError &&
        error.code === "query.record-too-large"
      )
        return { revision, documents, complete: false, cursor };
      throw error;
    }
    check();
    if (result.revision !== revision)
      throw new ControlPlaneError("query.stale-cursor", "Documents changed. Refresh to restart.");
    if (
      !Array.isArray(result.documents) ||
      result.documents.length > Math.min(50, limit - documents.length) ||
      encoder.encode(JSON.stringify(result)).byteLength > byteLimit ||
      typeof result.complete !== "boolean" ||
      (result.complete
        ? result.cursor !== null
        : typeof result.cursor !== "string" ||
          !result.cursor ||
          result.cursor.length > 16000 ||
          result.cursor === previous)
    )
      throw new ControlPlaneError("protocol.invalid-envelope", "Invalid canonical document page.");
    for (const document of result.documents) {
      if (!document || typeof document.id !== "string" || document.schemaVersion !== "0.10.1")
        throw new ControlPlaneError("protocol.invalid-envelope", "Invalid canonical document.");
      if (matchesDocument(document, scope)) {
        documents.push(document);
        retainedBytes += encoder.encode(JSON.stringify(document)).byteLength + 1;
      }
    }
    scanned += result.documents.length;
    cursor = result.cursor;
    if (
      result.complete ||
      documents.length >= limit ||
      scanned >= 1000 ||
      requests >= 20 ||
      Date.now() - started >= 250
    )
      return { revision, documents, complete: result.complete, cursor };
  }
}
