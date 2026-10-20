import { ControlPlaneError } from "./protocol";

export const WORKBENCH_LIMITS = {
  pageRecords: 50,
  responseBytes: 512 * 1024,
  cacheRecords: 250,
  cacheBytes: 2 * 1024 * 1024
} as const;

export interface WorkspaceBootstrap {
  id: string;
  revision: number;
  documentCount: number | null;
  savedGraphId: string | null;
}

export interface SearchPage {
  revision: number;
  projection: "search-row.v1";
  documents: Record<string, unknown>[];
  complete: boolean;
  cursor: string | null;
}

type Send = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const fail = (code: string, message: string): never => {
  throw new ControlPlaneError(code, message);
};

/** One route's page and canonical-ID cache. Returned values belong to the caller;
 * callers must replace their page/selection rather than accumulate these results. */
export function createWorkbenchReads(send: Send) {
  let generation = 0;
  let revision: number | null = null;
  let busy = false;
  let query: Record<string, unknown> | null = null;
  let cursor: string | null = null;
  let complete = true;
  let cacheBytes = 0;
  // Serialized entries cannot be mutated by an editor behind the byte accounting.
  const cache = new Map<string, { json: string; bytes: number }>();

  function invalidate() {
    generation += 1;
    revision = null;
    query = null;
    cursor = null;
    complete = true;
    cache.clear();
    cacheBytes = 0;
  }

  function reset(bootstrap: WorkspaceBootstrap) {
    invalidate();
    if (!Number.isSafeInteger(bootstrap.revision) || bootstrap.revision < 0)
      fail("protocol.invalid-envelope", "Invalid bootstrap revision.");
    revision = bootstrap.revision;
  }

  async function request<T>(command: string, payload: Record<string, unknown>): Promise<T> {
    if (revision === null)
      fail("control-plane.unavailable", "Bootstrap is required before reading.");
    if (busy) fail("query.busy", "Wait for the previous bounded read to settle.");
    const started = generation;
    busy = true;
    try {
      const result = await send<T & { revision: number }>(command, payload);
      if (started !== generation) fail("query.cancelled", "Read scope was invalidated.");
      if (bytes(result) > WORKBENCH_LIMITS.responseBytes)
        fail("query.record-too-large", "Read response exceeds the client byte budget.");
      if (result.revision !== revision) {
        invalidate();
        fail("query.stale-cursor", "Revision changed; bootstrap and restart the query.");
      }
      return result;
    } catch (error) {
      if (
        started === generation &&
        error instanceof ControlPlaneError &&
        error.code === "query.stale-cursor"
      )
        invalidate();
      throw error;
    } finally {
      busy = false;
    }
  }

  async function page(filters?: Record<string, unknown>): Promise<SearchPage> {
    if (busy) fail("query.busy", "Wait for the previous bounded read to settle.");
    if (filters !== undefined) {
      if ("cursor" in filters) fail("query.invalid", "Use next() for continuations.");
      // Freeze filter scope against caller mutations while a request is pending.
      if (bytes(filters) > 8192) fail("query.invalid", "Search scope exceeds 8192 bytes.");
      query = JSON.parse(JSON.stringify(filters)) as Record<string, unknown>;
      cursor = null;
      complete = false;
    }
    if (!query || complete) fail("query.complete", "Start a search before requesting a page.");
    const result = await request<SearchPage>("document.search", {
      ...query,
      limit: WORKBENCH_LIMITS.pageRecords,
      byteLimit: WORKBENCH_LIMITS.responseBytes,
      ...(cursor === null ? {} : { cursor })
    });
    if (
      result.projection !== "search-row.v1" ||
      !Array.isArray(result.documents) ||
      result.documents.length > WORKBENCH_LIMITS.pageRecords ||
      typeof result.complete !== "boolean" ||
      (result.complete
        ? result.cursor !== null
        : typeof result.cursor !== "string" ||
          !result.cursor ||
          result.cursor.length > 16000 ||
          result.cursor === cursor)
    ) {
      invalidate();
      fail("protocol.invalid-envelope", "Invalid bounded search page.");
    }
    cursor = result.cursor;
    complete = result.complete;
    // Do not retain rows or append previous pages; an empty page may continue.
    return result;
  }

  async function inspect(id: string): Promise<Record<string, unknown> | null> {
    if (!id || id.length > 512) fail("query.invalid", "Invalid document ID.");
    if (revision === null)
      fail("control-plane.unavailable", "Bootstrap is required before reading.");
    const hit = cache.get(id);
    if (hit) {
      cache.delete(id);
      cache.set(id, hit);
      return JSON.parse(hit.json) as Record<string, unknown>;
    }
    const result = await request<{
      revision: number;
      documents: Record<string, unknown>[];
      missingIds: string[];
    }>("document.batch", {
      ids: [id],
      expectedRevision: revision,
      byteLimit: WORKBENCH_LIMITS.responseBytes
    });
    if (
      !Array.isArray(result.documents) ||
      !Array.isArray(result.missingIds) ||
      !(
        (result.documents.length === 1 &&
          result.documents[0]?.id === id &&
          result.documents[0]?.schemaVersion === "0.10.1" &&
          result.missingIds.length === 0) ||
        (result.documents.length === 0 &&
          result.missingIds.length === 1 &&
          result.missingIds[0] === id)
      )
    )
      fail(
        "protocol.invalid-envelope",
        "ID lookup must explicitly report the requested record or absence."
      );
    const document = result.documents[0];
    // Only the server's explicit missingIds can establish absence. Eviction cannot.
    if (!document) return null;
    const json = JSON.stringify(document);
    const size = encoder.encode(json).byteLength;
    while (
      cache.size &&
      (cache.size >= WORKBENCH_LIMITS.cacheRecords ||
        cacheBytes + size > WORKBENCH_LIMITS.cacheBytes)
    ) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(id, { json, bytes: size });
    cacheBytes += size;
    return document;
  }

  return {
    reset,
    invalidate,
    // Cancellation is local: discard late replies and prevent further pulls.
    // The single in-flight transport request still settles or times out.
    cancel: invalidate,
    search: (filters: Record<string, unknown> = {}) => page(filters),
    next: () => page(),
    inspect,
    stats: () => ({ records: cache.size, bytes: cacheBytes, revision, busy })
  };
}

export type WorkbenchReads = ReturnType<typeof createWorkbenchReads>;
