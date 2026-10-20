import { describe, expect, it, vi } from "vitest";
import { exportWorkspaceToFile } from "./browser-export";
import type { ConnectionState, ControlPlaneClient } from "./client";
import { streamDocumentExport } from "./document-export";
function fixture() {
  let connection!: (state: ConnectionState) => void;
  const unsubscribe = vi.fn();
  const writer = {
    write: vi.fn<(data: string) => Promise<void>>(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {})
  };
  const handle = { createWritable: vi.fn(async () => writer) };
  const pickFile = vi.fn(async () => handle);
  const send = vi.fn(async (command: string) =>
    command === "system.capabilities"
      ? ["document.page"]
      : {
          revision: 4,
          documents: [{ id: "a", schemaVersion: "0.10.1", name: "é\nquoted" }],
          complete: true,
          cursor: null
        }
  );
  const client = {
    onConnectionStateChange: vi.fn((listener: typeof connection) => {
      connection = listener;
      listener({ synchronized: true } as ConnectionState);
      return unsubscribe;
    }),
    exportDocuments: vi.fn<ControlPlaneClient["exportDocuments"]>((sink, signal) =>
      streamDocumentExport(
        send as Parameters<typeof streamDocumentExport>[0],
        sink,
        () => {},
        signal
      )
    )
  };
  return {
    client,
    writer,
    pickFile,
    handle,
    send,
    unsubscribe,
    disconnect: () => connection({ synchronized: false } as ConnectionState)
  };
}
describe("browser workspace export", () => {
  it("streams canonical JSONL directly to the file writer and commits once", async () => {
    const f = fixture();
    await expect(exportWorkspaceToFile(f.client, { pickFile: f.pickFile })).resolves.toEqual({
      count: 1,
      revision: 4
    });
    expect(f.writer.write).toHaveBeenCalledWith(
      '{"id":"a","schemaVersion":"0.10.1","name":"é\\nquoted"}\n'
    );
    expect(f.writer.close).toHaveBeenCalledOnce();
    expect(f.writer.abort).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("does not export a newly selected workspace after a file-picker delay", async () => {
    const f = fixture();
    f.pickFile.mockImplementationOnce(async () => {
      f.disconnect();
      return f.handle;
    });
    await expect(exportWorkspaceToFile(f.client, { pickFile: f.pickFile })).rejects.toMatchObject({
      code: "query.cancelled"
    });
    expect(f.handle.createWritable).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("aborts a writer opened after navigation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.handle.createWritable.mockImplementationOnce(async () => {
      controller.abort();
      return f.writer;
    });
    await expect(
      exportWorkspaceToFile(f.client, { pickFile: f.pickFile, signal: controller.signal })
    ).rejects.toMatchObject({ code: "query.cancelled" });
    expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("aborts partial files on unsupported servers without materialized fallback", async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce([]);
    await expect(exportWorkspaceToFile(f.client, { pickFile: f.pickFile })).rejects.toMatchObject({
      code: "query.unsupported"
    });
    expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.writer.close).not.toHaveBeenCalled();
  });
  it("preserves picker cancellation and releases the subscription", async () => {
    const f = fixture();
    const error = new DOMException("cancelled", "AbortError");
    f.pickFile.mockRejectedValueOnce(error);
    await expect(exportWorkspaceToFile(f.client, { pickFile: f.pickFile })).rejects.toBe(error);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});
