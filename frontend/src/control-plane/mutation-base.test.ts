import { describe, expect, it, vi } from "vitest";
import { withMutationBase } from "./mutation-base";
import { ControlPlaneError } from "./protocol";
import type { ControlPlaneClient, ConnectionState } from "./client";
function fixture() {
  let connection!: (state: ConnectionState) => void;
  const send = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
    if (command === "workspace.bootstrap") return { revision: 4 };
    const ids = payload?.ids as string[];
    return {
      revision: 4,
      documents: ids
        .filter((id) => id !== "missing")
        .map((id) => ({ id, schemaVersion: "0.10.1" })),
      missingIds: ids.filter((id) => id === "missing")
    };
  });
  const unsubscribe = vi.fn();
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
describe("transaction touched-record lookup", () => {
  it("reads only distinct touched IDs in bounded batches at one revision", async () => {
    const f = fixture();
    const ids = Array.from({ length: 101 }, (_, n) => `id:${n}`);
    const apply = vi.fn(async ({ revision, documents }) => ({ revision, size: documents.size }));
    await expect(withMutationBase(f.client, [...ids, ids[0], "missing"], apply)).resolves.toEqual({
      revision: 4,
      size: 101
    });
    expect(f.send).toHaveBeenCalledTimes(4);
    expect(
      f.send.mock.calls.slice(1).map(([, payload]) => (payload?.ids as string[]).length)
    ).toEqual([50, 50, 2]);
    expect(f.send.mock.calls.slice(1).every(([, payload]) => payload?.expectedRevision === 4)).toBe(
      true
    );
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("splits oversized/deadline batches without dropping IDs", async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (command, payload) => {
      if (command === "document.batch" && (payload?.ids as string[]).length > 1)
        throw new ControlPlaneError("query.record-too-large", "split");
      return original(command, payload);
    });
    await expect(
      withMutationBase(f.client, ["a", "b"], async ({ documents }) => [...documents.keys()])
    ).resolves.toEqual(["a", "b"]);
  });
  it("never applies after a scope change or a mixed-revision batch", async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (command, payload) => {
      const result = await original(command, payload);
      if (command === "document.batch") f.disconnect();
      return result;
    });
    const apply = vi.fn();
    await expect(withMutationBase(f.client, ["a"], apply)).rejects.toMatchObject({
      code: "query.cancelled"
    });
    expect(apply).not.toHaveBeenCalled();
  });
  it("requires an explicit result for every ID before applying", async () => {
    const f = fixture();
    f.send
      .mockResolvedValueOnce({ revision: 4 })
      .mockResolvedValueOnce({ revision: 4, documents: [], missingIds: [] });
    const apply = vi.fn();
    await expect(withMutationBase(f.client, ["a"], apply)).rejects.toMatchObject({
      code: "protocol.invalid-envelope"
    });
    expect(apply).not.toHaveBeenCalled();
  });
  it("rejects an over-budget transaction before reading", async () => {
    const f = fixture();
    await expect(
      withMutationBase(
        f.client,
        Array.from({ length: 1001 }, (_, i) => String(i)),
        vi.fn()
      )
    ).rejects.toMatchObject({ code: "query.invalid" });
    expect(f.send).not.toHaveBeenCalled();
  });
});
