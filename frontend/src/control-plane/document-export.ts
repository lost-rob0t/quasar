import { ControlPlaneError } from "./protocol";
import { WORKBENCH_LIMITS } from "./workbench";

export interface DocumentExportSink {
  write(document: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  /** Discard the partial artifact; never append a restarted export to it. */
  abort(reason: unknown): Promise<void>;
}

interface CanonicalPage {
  revision: number;
  documents: Record<string, unknown>[];
  complete: boolean;
  cursor: string | null;
}

type Send = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

/** A sink must stream to durable output, not accumulate documents or Blob parts. */
export async function streamDocumentExport(
  send: Send,
  sink: DocumentExportSink,
  assertScope: () => void,
  signal?: AbortSignal
): Promise<{ count: number; revision: number }> {
  const check = () => {
    if (signal?.aborted) throw new ControlPlaneError("query.cancelled", "Export cancelled.");
    assertScope();
  };
  let cursor: string | null = null;
  let revision: number | null = null;
  let count = 0;
  try {
    check();
    const capabilities = await send<unknown>("system.capabilities", {});
    check();
    if (!Array.isArray(capabilities) || !capabilities.includes("document.page")) {
      throw new ControlPlaneError(
        "query.unsupported",
        "Server does not support streaming document export."
      );
    }
    for (;;) {
      check();
      const page: CanonicalPage = await send<CanonicalPage>("document.page", {
        limit: WORKBENCH_LIMITS.pageRecords,
        byteLimit: WORKBENCH_LIMITS.responseBytes,
        ...(cursor === null ? {} : { cursor })
      });
      check();
      if (
        new TextEncoder().encode(JSON.stringify(page)).byteLength >
          WORKBENCH_LIMITS.responseBytes ||
        !Number.isSafeInteger(page.revision) ||
        page.revision < 0 ||
        !Array.isArray(page.documents) ||
        page.documents.length > WORKBENCH_LIMITS.pageRecords ||
        !page.documents.every(
          (doc) => doc && typeof doc.id === "string" && doc.schemaVersion === "0.10.1"
        ) ||
        typeof page.complete !== "boolean" ||
        (page.complete
          ? page.cursor !== null
          : typeof page.cursor !== "string" ||
            !page.cursor ||
            page.cursor.length > 16000 ||
            page.cursor === cursor)
      ) {
        throw new ControlPlaneError("protocol.invalid-envelope", "Invalid canonical export page.");
      }
      if (revision !== null && revision !== page.revision) {
        throw new ControlPlaneError("query.stale-cursor", "Workspace changed during export.");
      }
      revision = page.revision;
      for (const document of page.documents) {
        check();
        await sink.write(document);
        check();
        count += 1;
      }
      if (page.complete) {
        check();
        await sink.close();
        return { count, revision: page.revision };
      }
      cursor = page.cursor;
    }
  } catch (error) {
    try {
      await sink.abort(error);
    } catch {
      /* Preserve the original read/write failure. */
    }
    throw error;
  }
}
