import { ControlPlaneError } from "./protocol";

type Send = <T>(command: string, payload: Record<string, unknown>) => Promise<T>;
export type DatasetPage = {
  revision: number;
  projection: "dataset-catalog.v1";
  datasets: { name: string; documentCount: number; types: string[]; updatedAt: number | null }[];
  complete: boolean;
  cursor: string | null;
};

/** Caller replaces the displayed page; never enumerate the catalog at startup. */
export async function readDatasetPage(send: Send, revision: number, cursor: string | null) {
  const page = await send<DatasetPage>("dataset.catalog", {
    limit: 50,
    byteLimit: 524288,
    expectedRevision: revision,
    ...(cursor === null ? {} : { cursor })
  });
  if (page.revision !== revision)
    throw new ControlPlaneError(
      "query.stale-cursor",
      "Dataset catalog changed. Refresh to restart."
    );
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 524288)
    throw new ControlPlaneError("query.record-too-large", "Dataset page exceeds its byte budget.");
  if (
    page.projection !== "dataset-catalog.v1" ||
    !Array.isArray(page.datasets) ||
    page.datasets.length > 50 ||
    typeof page.complete !== "boolean" ||
    (page.complete ? page.cursor !== null : typeof page.cursor !== "string" || !page.cursor) ||
    (!page.complete && page.cursor === cursor) ||
    page.datasets.some(
      (row) =>
        !row ||
        typeof row.name !== "string" ||
        !row.name ||
        !Number.isSafeInteger(row.documentCount) ||
        row.documentCount < 1 ||
        !Array.isArray(row.types) ||
        row.types.some((type) => typeof type !== "string") ||
        (row.updatedAt !== null && !Number.isFinite(row.updatedAt))
    ) ||
    new Set(page.datasets.map((row) => row.name)).size !== page.datasets.length
  )
    throw new ControlPlaneError("protocol.invalid-envelope", "Invalid dataset catalog page.");
  return page;
}
