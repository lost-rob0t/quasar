import { describe, expect, it, vi } from "vitest";
import { readCanonicalDocument } from "./canonical-read";
import type { ControlPlaneClient, ConnectionState } from "./client";
const doc = { id: "a", schemaVersion: "0.10.1", name: "canonical" };
function fixture(batch = { revision: 4, documents: [doc], missingIds: [] as string[] }) {
  let connection!: (state: ConnectionState) => void;
  const unsubscribe = vi.fn();
  const send = vi.fn().mockResolvedValueOnce({ revision: 4 }).mockResolvedValueOnce(batch);
  return {
    send,
    unsubscribe,
    client: {
      send: send as ControlPlaneClient["send"],
      onConnectionStateChange: (listener: typeof connection) => {
        connection = listener;
        listener({ synchronized: true } as ConnectionState);
        return unsubscribe;
      }
    },
    disconnect: () => connection({ synchronized: false } as ConnectionState)
  };
}
describe("route canonical inspection", () => {
  it("fetches a canonical ID without a provider document array", async () => {
    const f = fixture();
    await expect(readCanonicalDocument(f.client, "a")).resolves.toEqual(doc);
    expect(f.send).toHaveBeenNthCalledWith(2, "document.batch", {
      ids: ["a"],
      expectedRevision: 4,
      byteLimit: 524288
    });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("treats only explicit missingIds as not found", async () => {
    const f = fixture({ revision: 4, documents: [], missingIds: ["a"] });
    await expect(readCanonicalDocument(f.client, "a")).resolves.toBeNull();
    const ambiguous = fixture({ revision: 4, documents: [], missingIds: [] });
    await expect(readCanonicalDocument(ambiguous.client, "a")).rejects.toMatchObject({
      code: "protocol.invalid-envelope"
    });
  });
  it("discards lookup results on workspace/reconnect change", async () => {
    const f = fixture();
    f.send
      .mockReset()
      .mockResolvedValueOnce({ revision: 4 })
      .mockImplementationOnce(async () => {
        f.disconnect();
        return { revision: 4, documents: [doc], missingIds: [] };
      });
    await expect(readCanonicalDocument(f.client, "a")).rejects.toMatchObject({
      code: "query.cancelled"
    });
  });
  it("discards lookup results on navigation cancellation", async () => {
    const f = fixture();
    const signal = AbortSignal.abort();
    await expect(readCanonicalDocument(f.client, "a", signal)).rejects.toMatchObject({
      code: "query.cancelled"
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects mixed revisions instead of returning an obsolete editor base", async () => {
    const f = fixture({ revision: 5, documents: [doc], missingIds: [] });
    await expect(readCanonicalDocument(f.client, "a")).rejects.toMatchObject({
      code: "query.stale-cursor"
    });
  });
});
