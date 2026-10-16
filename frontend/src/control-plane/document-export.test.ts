import { describe, expect, it, vi } from "vitest";
import { streamDocumentExport } from "./document-export";
import { ControlPlaneError } from "./protocol";
const doc = { id: "a", schemaVersion: "0.10.1" };
const page = (
  cursor: string | null = null,
  documents: Record<string, unknown>[] = [doc],
  revision = 4
) => ({
  cursor,
  documents,
  revision,
  complete: cursor === null
});
function fixture(pages: unknown[]) {
  const send = vi.fn(async (command: string) =>
    command === "system.capabilities" ? ["document.page"] : pages.shift()
  );
  const sink = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {})
  };
  return {
    send,
    sink,
    run: (scope = () => {}, signal?: AbortSignal) =>
      streamDocumentExport(send as Parameters<typeof streamDocumentExport>[0], sink, scope, signal)
  };
}
describe("canonical streaming export", () => {
  it("awaits each sink write before pulling another page and handles empty terminal pages", async () => {
    const { send, sink, run } = fixture([page("next"), page(null, [])]);
    let release!: () => void;
    sink.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const result = run();
    await vi.waitFor(() => expect(sink.write).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(2);
    release();
    await expect(result).resolves.toEqual({ count: 1, revision: 4 });
    expect(send.mock.calls[2]).toEqual([
      "document.page",
      { limit: 50, byteLimit: 524288, cursor: "next" }
    ]);
    expect(sink.close).toHaveBeenCalledOnce();
    expect(sink.abort).not.toHaveBeenCalled();
  });
  it("honors empty-but-continuable pages", async () => {
    const { run, sink } = fixture([page("next", []), page()]);
    await expect(run()).resolves.toEqual({ count: 1, revision: 4 });
    expect(sink.write).toHaveBeenCalledTimes(1);
  });
  it("aborts on stale revision without restarting or writing the changed page", async () => {
    const { run, sink, send } = fixture([page("next"), page(null, [doc], 5)]);
    await expect(run()).rejects.toMatchObject({ code: "query.stale-cursor" });
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(sink.close).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("does not fall back when capability is missing", async () => {
    const { run, sink, send } = fixture([]);
    send.mockResolvedValueOnce([]);
    await expect(run()).rejects.toMatchObject({ code: "query.unsupported" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("aborts on navigation during a sink write before any next pull", async () => {
    const { run, sink, send } = fixture([page("next"), page()]);
    let valid = true;
    sink.write.mockImplementationOnce(async () => {
      valid = false;
    });
    await expect(
      run(() => {
        if (!valid) throw new ControlPlaneError("query.cancelled", "navigation");
      })
    ).rejects.toMatchObject({ code: "query.cancelled" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("honors cancellation while a page is in flight", async () => {
    const { run, send, sink } = fixture([]);
    const controller = new AbortController();
    send.mockResolvedValueOnce(["document.page"]).mockImplementationOnce(async () => {
      controller.abort();
      return page();
    });
    await expect(run(() => {}, controller.signal)).rejects.toMatchObject({
      code: "query.cancelled"
    });
    expect(sink.write).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("preserves sink errors even when abort also fails", async () => {
    const { run, sink, send } = fixture([page("next")]);
    const error = new Error("disk full");
    sink.write.mockRejectedValueOnce(error);
    sink.abort.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(run()).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sink.close).not.toHaveBeenCalled();
  });
  it.each([
    page(null, [{ id: "projection", schemaVersion: "search-row.v1" }]),
    page(null, [{ ...doc, body: "x".repeat(524288) }])
  ])("rejects invalid canonical pages before output", async (invalid) => {
    const { run, sink } = fixture([invalid]);
    await expect(run()).rejects.toMatchObject({ code: "protocol.invalid-envelope" });
    expect(sink.write).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalledOnce();
  });
});
