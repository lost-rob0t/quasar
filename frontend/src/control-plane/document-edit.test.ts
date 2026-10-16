import { describe, expect, it, vi } from "vitest";
import { commitDocumentEdit } from "./document-edit";
import type { ControlPlaneClient, ConnectionState } from "./client";
const previous = { id: "a", schemaVersion: "0.10.1", name: "before" };
function fixture(exists = true) {
  let listener!: (state: ConnectionState) => void;
  const unsubscribe = vi.fn();
  const send = vi
    .fn()
    .mockResolvedValueOnce({ revision: 4 })
    .mockResolvedValueOnce({
      revision: 4,
      documents: exists ? [previous] : [],
      missingIds: exists ? [] : ["a"]
    });
  const transaction = vi.fn().mockResolvedValue({ results: [{ revision: 5 }] });
  const client = {
    send: send as ControlPlaneClient["send"],
    transaction,
    onConnectionStateChange: (callback: typeof listener) => {
      listener = callback;
      callback({ synchronized: true } as ConnectionState);
      return unsubscribe;
    }
  };
  return {
    client,
    send,
    transaction,
    unsubscribe,
    disconnect: () => listener({ synchronized: false } as ConnectionState)
  };
}
describe("canonical single-document edits", () => {
  it("captures the authoritative undo record without snapshot or cache existence decisions", async () => {
    const f = fixture();
    const updated = { ...previous, name: "after" };
    await expect(commitDocumentEdit(f.client, "a", updated)).resolves.toEqual({
      previous,
      result: { revision: 5 }
    });
    expect(f.send.mock.calls).toEqual([
      ["workspace.bootstrap", {}],
      ["document.batch", { ids: ["a"], expectedRevision: 4, byteLimit: 524288 }]
    ]);
    expect(f.transaction).toHaveBeenCalledWith([{ type: "document.update", payload: updated }], 4);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("creates only after explicit absence and returns no previous record for undo", async () => {
    const f = fixture(false);
    await expect(commitDocumentEdit(f.client, "a", previous)).resolves.toMatchObject({
      previous: null
    });
    expect(f.transaction).toHaveBeenCalledWith([{ type: "document.create", payload: previous }], 4);
  });
  it("captures canonical deleted content for undo", async () => {
    const f = fixture();
    await expect(commitDocumentEdit(f.client, "a")).resolves.toMatchObject({ previous });
    expect(f.transaction).toHaveBeenCalledWith(
      [{ type: "document.delete", payload: { id: "a" } }],
      4
    );
  });
  it("rejects a concurrent revision conflict without retrying or manufacturing history", async () => {
    const f = fixture();
    const error = new Error("revision conflict");
    f.transaction.mockRejectedValueOnce(error);
    await expect(commitDocumentEdit(f.client, "a", previous)).rejects.toBe(error);
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("does not mutate a workspace switched during canonical lookup", async () => {
    const f = fixture();
    f.send
      .mockReset()
      .mockResolvedValueOnce({ revision: 4 })
      .mockImplementationOnce(async () => {
        f.disconnect();
        return { revision: 4, documents: [previous], missingIds: [] };
      });
    await expect(commitDocumentEdit(f.client, "a", previous)).rejects.toMatchObject({
      code: "query.cancelled"
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("never overwrites an existing ID for explicit create intent", async () => {
    const f = fixture();
    await expect(commitDocumentEdit(f.client, "a", previous, "create")).rejects.toMatchObject({
      code: "document.duplicate-id"
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("never recreates a deleted record for explicit edit intent", async () => {
    const f = fixture(false);
    await expect(commitDocumentEdit(f.client, "a", previous, "update")).rejects.toMatchObject({
      code: "document.not-found"
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("refuses ambiguous missing-record responses", async () => {
    const f = fixture();
    f.send
      .mockReset()
      .mockResolvedValueOnce({ revision: 4 })
      .mockResolvedValueOnce({ revision: 4, documents: [], missingIds: [] });
    await expect(commitDocumentEdit(f.client, "a", previous)).rejects.toMatchObject({
      code: "protocol.invalid-envelope"
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
