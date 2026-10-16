import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

interface FileWriter {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
type PickFile = (
  options: Record<string, unknown>
) => Promise<{ createWritable(): Promise<FileWriter> }>;
type ExportClient = Pick<ControlPlaneClient, "exportDocuments" | "onConnectionStateChange">;

/** Open a transactional file writer from the click gesture; never accumulate Blob parts. */
export async function exportWorkspaceToFile(
  client: ExportClient,
  {
    signal,
    pickFile = (
      globalThis as typeof globalThis & { showSaveFilePicker?: PickFile }
    ).showSaveFilePicker?.bind(globalThis)
  }: { signal?: AbortSignal; pickFile?: PickFile } = {}
) {
  if (!pickFile)
    throw new ControlPlaneError(
      "export.unsupported-browser",
      "Streaming workspace export requires a browser with Save File support. Existing result and historical exports remain available."
    );
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const unsubscribe = client.onConnectionStateChange((state) => {
    if (!state.synchronized) cancel();
  });
  const check = () => {
    if (controller.signal.aborted)
      throw new ControlPlaneError("query.cancelled", "Workspace export cancelled.");
  };
  let writer: FileWriter | undefined;
  let handedOff = false;
  try {
    check();
    const handle = await pickFile({
      suggestedName: "quasar-workspace.jsonl",
      types: [
        {
          description: "Canonical StarIntel JSON Lines",
          accept: { "application/x-ndjson": [".jsonl"] }
        }
      ]
    });
    check();
    writer = await handle.createWritable();
    check();
    const output = writer;
    handedOff = true;
    return await client.exportDocuments(
      {
        write: (document) => output.write(`${JSON.stringify(document)}\n`),
        close: () => output.close(),
        abort: (error) => output.abort(error)
      },
      controller.signal
    );
  } catch (error) {
    if (writer && !handedOff) {
      try {
        await writer.abort(error);
      } catch {
        /* Preserve cancellation/open failure. */
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    unsubscribe();
  }
}
