import type { ControlPlaneClient } from "./client";
import { matchesDocument, type DocumentScope } from "./document-list";
import { toLegacyUiDocument } from "../lib/canonical-document";
import { graphRenderDecision } from "../lib/graph-scale";
import { exportWorkspaceToFile } from "./browser-export";
import { downloadText } from "../lib/importer";

export async function exportDocumentResults(
  client: ControlPlaneClient,
  scope: DocumentScope,
  historical = false
) {
  let matched = 0;
  const filtered: Pick<ControlPlaneClient, "exportDocuments" | "onConnectionStateChange"> = {
    onConnectionStateChange: client.onConnectionStateChange,
    exportDocuments: async (sink, signal) => {
      const result = await client.exportDocuments(
        {
          write: async (document) => {
            if (matchesDocument(document, scope)) {
              await sink.write(historical ? toLegacyUiDocument(document) : document);
              matched += 1;
            }
          },
          close: () => sink.close(),
          abort: (error) => sink.abort(error)
        },
        signal
      );
      return { ...result, count: matched };
    }
  };
  if ("showSaveFilePicker" in globalThis) return exportWorkspaceToFile(filtered);
  // Compatibility download for small results on browsers without a transactional writer.
  let text = "",
    bytes = 0;
  const result = await filtered.exportDocuments({
    write: async (document) => {
      const line = `${JSON.stringify(document)}\n`;
      bytes += new TextEncoder().encode(line).byteLength;
      if (bytes > 2097152)
        throw new Error(
          "These results exceed the browser download budget. Use streaming workspace export in a browser with Save File support."
        );
      text += line;
    },
    close: async () => {},
    abort: async () => {
      text = "";
    }
  });
  downloadText(
    historical ? "starintel-historical-archive.jsonl" : "starintel-documents.jsonl",
    text
  );
  return result;
}

export async function graphDocumentsForScope(client: ControlPlaneClient, scope: DocumentScope) {
  const documents: Record<string, unknown>[] = [];
  let bytes = 0;
  await client.exportDocuments({
    write: async (document) => {
      if (!matchesDocument(document, scope)) return;
      bytes += new TextEncoder().encode(JSON.stringify(document)).byteLength;
      if (documents.length >= 2000 || bytes > 8388608)
        throw new Error("Narrow the search before importing it into a graph.");
      documents.push(toLegacyUiDocument(document));
    },
    close: async () => {},
    abort: async () => {
      documents.length = 0;
    }
  });
  if (!graphRenderDecision(documents).allowed)
    throw new Error("Narrow the search before importing it into a graph.");
  return documents;
}

/** Exact transitive relation closure; each pass streams, retaining only bounded IDs. */
export async function relatedDeletionIds(client: ControlPlaneClient, id: string | string[]) {
  const selected = new Set(Array.isArray(id) ? id : [id]);
  if (selected.size > 1000)
    throw new Error("Related deletion exceeds the atomic transaction limit.");
  let revision: number | undefined;
  for (;;) {
    const size = selected.size;
    const result = await client.exportDocuments({
      write: async (document) => {
        if (document.dtype !== "relation" || selected.has(String(document.id))) return;
        const source = document.source as { id?: string } | undefined;
        const destination = document.destination as { id?: string } | undefined;
        if (selected.has(source?.id || "") || selected.has(destination?.id || "")) {
          if (selected.size >= 1000)
            throw new Error("Related deletion exceeds the atomic transaction limit.");
          selected.add(String(document.id));
        }
      },
      close: async () => {},
      abort: async () => {}
    });
    if (revision !== undefined && revision !== result.revision)
      throw new Error("Documents changed while resolving related deletions. Retry the deletion.");
    revision = result.revision;
    if (selected.size === size) return { ids: [...selected], revision };
  }
}

export async function connectingRelationIds(client: ControlPlaneClient, members: string[]) {
  const ids = new Set(members);
  const relations: string[] = [];
  if (ids.size > 2000) throw new Error("Graph membership exceeds the renderer budget.");
  await client.exportDocuments({
    write: async (document) => {
      if (document.dtype !== "relation") return;
      const source = document.source as { id?: string } | undefined;
      const destination = document.destination as { id?: string } | undefined;
      if (
        !ids.has(String(document.id)) &&
        ids.has(source?.id || "") &&
        ids.has(destination?.id || "")
      ) {
        if (relations.length + ids.size >= 2000)
          throw new Error("Graph membership exceeds the renderer budget.");
        relations.push(String(document.id));
      }
    },
    close: async () => {},
    abort: async () => {}
  });
  return relations;
}
