import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";
import { toLegacyUiDocument } from "../lib/canonical-document";
import { graphRenderDecision } from "../lib/graph-scale";
import { withWorkspaceScope } from "./workspace-scope";

type Client = Pick<ControlPlaneClient, "send" | "onConnectionStateChange">;
// Dynamic wire objects are checked at each bounded response boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fail = (message: string): never => {
  throw new ControlPlaneError("query.record-too-large", message);
};
export const GRAPH_READ_LIMITS = {
  documents: 2000,
  nodes: 1500,
  edges: 3000,
  bytes: 8 * 1024 * 1024
};

export async function readGraphCatalog(client: Client, revision: number, cursor?: string) {
  const result = await client.send<Json>("graph.catalog", {
    limit: 50,
    byteLimit: 524288,
    expectedRevision: revision,
    ...(cursor ? { cursor } : {})
  });
  if (result.revision !== revision)
    throw new ControlPlaneError("query.stale-cursor", "Graph catalog changed.");
  if (
    result.projection !== "graph-catalog.v1" ||
    !Array.isArray(result.graphs) ||
    result.graphs.length > 50 ||
    size(result) > 524288 ||
    typeof result.complete !== "boolean" ||
    (result.complete
      ? result.cursor !== null
      : typeof result.cursor !== "string" || !result.cursor || result.cursor === cursor)
  )
    throw new Error("Invalid graph catalog page.");
  for (const graph of result.graphs)
    if (
      !graph ||
      typeof graph.id !== "string" ||
      typeof graph.name !== "string" ||
      !["all", "explicit"].includes(graph.membershipMode)
    )
      throw new Error("Invalid graph catalog row.");
  return result;
}

/** Complete only the explicitly requested graph, within existing renderer bounds. */
export function readCompleteGraph(client: Client, graphId: string, revision: number) {
  return withWorkspaceScope(client, async (check) => {
    let bytes = 0;
    const section = async (name: string, maximum: number) => {
      const records: Json[] = [];
      let cursor: string | undefined;
      for (let request = 0; request < 100; request += 1) {
        check();
        const page = await client.send<Json>("graph.page", {
          graphId,
          section: name,
          expectedRevision: revision,
          limit: 50,
          byteLimit: 524288,
          ...(cursor ? { cursor } : {})
        });
        check();
        if (page.revision !== revision)
          throw new ControlPlaneError("query.stale-cursor", "Graph changed while loading.");
        if (
          page.projection !== "graph-page.v1" ||
          page.graphId !== graphId ||
          page.section !== name ||
          !Array.isArray(page.records) ||
          page.records.length > 50 ||
          size(page) > 524288 ||
          typeof page.complete !== "boolean" ||
          (page.complete
            ? page.cursor !== null
            : typeof page.cursor !== "string" || !page.cursor || page.cursor === cursor)
        )
          throw new Error("Invalid graph section page.");
        bytes += size(page.records);
        if (records.length + page.records.length > maximum || bytes > GRAPH_READ_LIMITS.bytes)
          fail(
            "This graph exceeds the interactive graph budget. Narrow its membership before opening it."
          );
        records.push(...page.records);
        if (page.complete) return records;
        cursor = page.cursor;
      }
      throw new ControlPlaneError(
        "query.deadline",
        "Graph paging did not finish within the request budget."
      );
    };
    const descriptor = await section("descriptor", 1);
    if (descriptor.length !== 1 || !descriptor[0].metadata || !descriptor[0].collectionKinds)
      throw new Error("Graph descriptor is incomplete.");
    const { metadata, collectionKinds: kinds } = descriptor[0];
    if (!["null", "array"].includes(kinds.documentIds))
      throw new Error("Invalid membership collection type.");
    const members = await section("members", GRAPH_READ_LIMITS.documents);
    const ids = members.map((row) => row.documentId);
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length)
      throw new Error("Invalid graph membership.");
    const graph: Json = {
      ...metadata,
      id: graphId,
      documentIds: kinds.documentIds === "null" ? null : ids
    };
    for (const [field, name] of [
      ["positions", "positions"],
      ["groups", "groups"],
      ["selectedIds", "selection"]
    ]) {
      const kind = kinds[field];
      if (!["null", "array", "object"].includes(kind))
        throw new Error("Unknown graph collection type.");
      const records = await section(name, 2000);
      if (kind === "null") {
        if (records.length) throw new Error("Unexpected null graph collection.");
        graph[field] = null;
      } else if (kind === "array") {
        if (records.some((row, index) => row.index !== index))
          throw new Error("Invalid graph collection order.");
        graph[field] = records.map((row) => row.value);
      } else {
        if (
          records.some((row) => typeof row.key !== "string") ||
          new Set(records.map((row) => row.key)).size !== records.length
        )
          throw new Error("Invalid graph collection keys.");
        graph[field] = Object.fromEntries(records.map((row) => [row.key, row.value]));
      }
    }
    graph.nodes = await section("nodes", GRAPH_READ_LIMITS.nodes);
    graph.edges = await section("edges", GRAPH_READ_LIMITS.edges);
    const documents: Json[] = [];
    const read = async (batch: string[]): Promise<void> => {
      check();
      let result: Json;
      try {
        result = await client.send<Json>("document.batch", {
          ids: batch,
          expectedRevision: revision,
          byteLimit: 524288
        });
      } catch (error) {
        check();
        if (
          batch.length > 1 &&
          error instanceof ControlPlaneError &&
          ["query.record-too-large", "query.deadline"].includes(error.code)
        ) {
          const middle = Math.ceil(batch.length / 2);
          await read(batch.slice(0, middle));
          await read(batch.slice(middle));
          return;
        }
        throw error;
      }
      check();
      if (result.revision !== revision)
        throw new ControlPlaneError("query.stale-cursor", "Graph documents changed.");
      if (
        !Array.isArray(result.documents) ||
        !Array.isArray(result.missingIds) ||
        size(result) > 524288
      )
        throw new Error("Invalid graph document batch.");
      const outstanding = new Set(batch);
      for (const document of result.documents) {
        if (!document || document.schemaVersion !== "0.10.1" || !outstanding.delete(document.id))
          throw new Error("Unexpected graph document.");
        bytes += size(document);
        if (bytes > GRAPH_READ_LIMITS.bytes)
          fail("This graph exceeds the interactive document byte budget.");
        documents.push(toLegacyUiDocument(document));
      }
      for (const id of result.missingIds)
        if (!outstanding.delete(id)) throw new Error("Unexpected missing graph member.");
      if (outstanding.size) throw new Error("Graph lookup omitted member IDs.");
    };
    for (let offset = 0; offset < ids.length; offset += 50)
      await read(ids.slice(offset, offset + 50));
    if (!graphRenderDecision(documents).allowed)
      fail("This graph exceeds the interactive renderer limits.");
    check();
    return { graph, documents, revision };
  });
}
