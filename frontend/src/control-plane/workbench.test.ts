import { describe, expect, it, vi } from "vitest";
import { ControlPlaneError } from "./protocol";
import { createWorkbenchReads, WORKBENCH_LIMITS } from "./workbench";

const bootstrap = { id: "default", revision: 4, documentCount: 100000, savedGraphId: null };
const document = (id: string) => ({
  id,
  schemaVersion: "0.10.1",
  dtype: "person",
  dataset: "test"
});
const page = (cursor: string | null = null) => ({
  revision: 4,
  projection: "search-row.v1",
  documents: [],
  complete: cursor === null,
  cursor
});
function fixture(handler: (command: string, payload: Record<string, unknown>) => unknown) {
  const send = vi.fn(async (command: string, payload: Record<string, unknown> = {}) =>
    handler(command, payload)
  );
  const reads = createWorkbenchReads(send as Parameters<typeof createWorkbenchReads>[0]);
  reads.reset(bootstrap);
  return { reads, send };
}

describe("bounded route reads", () => {
  it("pulls exactly one page, including empty-but-continuable pages", async () => {
    const { reads, send } = fixture((_command, payload) => page(payload.cursor ? null : "next"));
    const filters = { q: "alice", limit: 100000 };
    expect(await reads.search(filters)).toMatchObject({ documents: [], complete: false });
    filters.q = "changed";
    expect(send).toHaveBeenCalledTimes(1);
    expect(await reads.next()).toMatchObject({ complete: true });
    expect(send.mock.calls[1]).toEqual([
      "document.search",
      {
        q: "alice",
        limit: 50,
        byteLimit: 524288,
        cursor: "next"
      }
    ]);
    await expect(reads.next()).rejects.toMatchObject({ code: "query.complete" });
    expect(reads.stats().records).toBe(0);
  });

  it("fetches canonical IDs instead of treating a cache miss as absence", async () => {
    const { reads, send } = fixture((_command, payload) => ({
      revision: 4,
      documents:
        (payload.ids as string[])[0] === "missing"
          ? []
          : [document(String((payload.ids as string[])[0]))],
      missingIds: (payload.ids as string[])[0] === "missing" ? ["missing"] : []
    }));
    expect(await reads.inspect("alice")).toEqual(document("alice"));
    expect(await reads.inspect("missing")).toBeNull();
    await reads.inspect("missing");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("evicts least-recently-used records and refetches evicted IDs", async () => {
    const { reads, send } = fixture((_command, payload) => ({
      revision: 4,
      documents: [document((payload.ids as string[])[0])],
      missingIds: []
    }));
    for (let n = 0; n < 250; n++) await reads.inspect(String(n));
    await reads.inspect("0");
    await reads.inspect("250");
    expect(reads.stats().records).toBe(250);
    expect(send).toHaveBeenCalledTimes(251);
    await reads.inspect("0");
    expect(send).toHaveBeenCalledTimes(251);
    await reads.inspect("1");
    expect(send).toHaveBeenCalledTimes(252);
  });

  it("enforces UTF-8 bytes independently of record count and caller mutation", async () => {
    const { reads, send } = fixture((_command, payload) => ({
      revision: 4,
      documents: [{ ...document((payload.ids as string[])[0]), body: "é".repeat(100000) }],
      missingIds: []
    }));
    for (let n = 0; n < 20; n++) await reads.inspect(String(n));
    expect(reads.stats().records).toBeLessThan(20);
    expect(reads.stats().bytes).toBeLessThanOrEqual(WORKBENCH_LIMITS.cacheBytes);
    const record = (await reads.inspect("19"))!;
    record.body = "mutated";
    expect((await reads.inspect("19"))!.body).not.toBe("mutated");
    expect(send).toHaveBeenCalledTimes(20);
  });

  it.each([10000, 100000])(
    "retains identical cache budgets for declared corpus %i",
    async (count) => {
      const { reads, send } = fixture(() => page());
      reads.reset({ ...bootstrap, documentCount: count });
      await reads.search();
      expect(reads.stats()).toEqual({ records: 0, bytes: 0, revision: 4, busy: false });
      expect(send).toHaveBeenCalledTimes(1);
      // Synthetic contract check, not a server corpus/heap benchmark.
    }
  );

  it("invalidates stale continuations and requires a fresh bootstrap", async () => {
    const { reads } = fixture(() => {
      throw new ControlPlaneError("query.stale-cursor", "changed");
    });
    await expect(reads.search()).rejects.toMatchObject({ code: "query.stale-cursor" });
    expect(reads.stats().revision).toBeNull();
    await expect(reads.search()).rejects.toMatchObject({ code: "control-plane.unavailable" });
  });

  it("never combines pages from different revisions", async () => {
    const { reads } = fixture(() => ({ ...page(), revision: 5 }));
    await expect(reads.search()).rejects.toMatchObject({ code: "query.stale-cursor" });
    expect(reads.stats().revision).toBeNull();
  });

  it("discards late ID replies after workspace/navigation cancellation", async () => {
    let resolve!: (result: unknown) => void;
    const { reads, send } = fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = reads.inspect("alice");
    reads.cancel();
    reads.reset({ ...bootstrap, id: "other" });
    await expect(reads.inspect("bob")).rejects.toMatchObject({ code: "query.busy" });
    resolve({ revision: 4, documents: [document("alice")], missingIds: [] });
    await expect(pending).rejects.toMatchObject({ code: "query.cancelled" });
    expect(reads.stats().records).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a new scope when an obsolete request fails", async () => {
    let reject!: (error: unknown) => void;
    const { reads } = fixture(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const pending = reads.search();
    reads.reset({ ...bootstrap, id: "other", revision: 8 });
    reject(new ControlPlaneError("query.stale-cursor", "old scope"));
    await expect(pending).rejects.toMatchObject({ code: "query.stale-cursor" });
    expect(reads.stats().revision).toBe(8);
  });

  it("rejects oversized records and never caches them", async () => {
    const { reads } = fixture(() => ({
      revision: 4,
      documents: [{ ...document("alice"), body: "x".repeat(524288) }],
      missingIds: []
    }));
    await expect(reads.inspect("alice")).rejects.toMatchObject({ code: "query.record-too-large" });
    expect(reads.stats().records).toBe(0);
  });

  it("rejects ambiguous absence and projection responses to canonical lookup", async () => {
    const { reads } = fixture(() => ({ revision: 4, documents: [], missingIds: [] }));
    await expect(reads.inspect("alice")).rejects.toMatchObject({
      code: "protocol.invalid-envelope"
    });
  });

  it("rejects repeating cursors without draining", async () => {
    const { reads, send } = fixture(() => page("same"));
    await reads.search();
    await expect(reads.next()).rejects.toMatchObject({ code: "protocol.invalid-envelope" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
