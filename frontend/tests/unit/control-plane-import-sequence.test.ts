import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("../../src/control-plane/client", () => ({
  getControlPlane: () => ({ send }),
  ControlPlaneClient: undefined
}));

import { cpImportDocuments } from "../../src/control-plane/mutations";

describe("durable document import sequencing", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("numbers chunks monotonically and commits the same durable session", async () => {
    send
      .mockResolvedValueOnce({ sessionId: "stage-123", baseRevision: 7 })
      .mockResolvedValueOnce({ sessionId: "stage-123", acceptedThrough: 0, documentCount: 1 })
      .mockResolvedValueOnce({ sessionId: "stage-123", acceptedThrough: 1, documentCount: 2 })
      .mockResolvedValueOnce({ sessionId: "stage-123", revision: 8, documentCount: 2 });

    const chunks = [
      [{ type: "document.create", payload: { _id: "a", dtype: "person" } }],
      [{ type: "document.create", payload: { _id: "b", dtype: "person" } }]
    ];

    await expect(cpImportDocuments(chunks)).resolves.toMatchObject({
      revision: 8,
      documentCount: 2
    });

    expect(send).toHaveBeenNthCalledWith(1, "document.import.begin", {});
    expect(send).toHaveBeenNthCalledWith(2, "document.import.chunk", {
      sessionId: "stage-123",
      sequence: 0,
      operations: chunks[0]
    });
    expect(send).toHaveBeenNthCalledWith(3, "document.import.chunk", {
      sessionId: "stage-123",
      sequence: 1,
      operations: chunks[1]
    });
    expect(send).toHaveBeenNthCalledWith(4, "document.import.commit", {
      sessionId: "stage-123"
    });
  });

  it("aborts the exact stage when a chunk fails", async () => {
    const failure = new Error("chunk rejected");
    send
      .mockResolvedValueOnce({ sessionId: "stage-fail", baseRevision: 2 })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ sessionId: "stage-fail", aborted: true });

    await expect(
      cpImportDocuments([[{ type: "document.create", payload: { _id: "bad", dtype: "person" } }]])
    ).rejects.toBe(failure);

    expect(send).toHaveBeenNthCalledWith(2, "document.import.chunk", {
      sessionId: "stage-fail",
      sequence: 0,
      operations: [{ type: "document.create", payload: { _id: "bad", dtype: "person" } }]
    });
    expect(send).toHaveBeenNthCalledWith(3, "document.import.abort", {
      sessionId: "stage-fail"
    });
  });
});
