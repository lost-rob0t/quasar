import { describe, expect, it, vi } from "vitest";
import { readDatasetPage, type DatasetPage } from "./dataset-catalog";
const page: DatasetPage = {
  revision: 4,
  projection: "dataset-catalog.v1",
  datasets: [{ name: "main", documentCount: 100000, types: ["person"], updatedAt: 1700000000 }],
  complete: true,
  cursor: null
};
describe("bounded dataset catalog", () => {
  it("requests a single bounded page and preserves authoritative counts and Unix seconds", async () => {
    const send = vi.fn(async () => page);
    expect(await readDatasetPage(send as Parameters<typeof readDatasetPage>[0], 4, null)).toEqual(
      page
    );
    expect(send).toHaveBeenCalledExactlyOnceWith("dataset.catalog", {
      limit: 50,
      byteLimit: 524288,
      expectedRevision: 4
    });
  });
  it("accepts an empty continuable page without draining it", async () => {
    const send = vi.fn(async () => ({ ...page, datasets: [], complete: false, cursor: "next" }));
    expect(
      await readDatasetPage(send as Parameters<typeof readDatasetPage>[0], 4, "prior")
    ).toMatchObject({ complete: false });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { revision: 5 },
    { projection: "other" },
    { complete: false, cursor: null },
    { complete: false, cursor: "prior" },
    { datasets: Array(51).fill(page.datasets[0]) },
    { datasets: [{ ...page.datasets[0], documentCount: -1 }] },
    { datasets: [{ ...page.datasets[0], types: [42] }] },
    { datasets: [page.datasets[0], page.datasets[0]] },
    { datasets: [{ ...page.datasets[0], name: "é".repeat(300000) }] }
  ])("rejects malformed, oversized or stale responses %j", async (change) => {
    const send = async () => ({ ...page, ...change });
    await expect(
      readDatasetPage(send as Parameters<typeof readDatasetPage>[0], 4, "prior")
    ).rejects.toThrow();
  });
  it("preserves explicit migration errors without any fallback scan", async () => {
    const send = vi.fn(async () => {
      throw new Error("dataset.catalog-migration-required");
    });
    await expect(readDatasetPage(send, 4, null)).rejects.toThrow(
      "dataset.catalog-migration-required"
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
