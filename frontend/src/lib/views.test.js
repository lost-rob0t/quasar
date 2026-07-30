import { describe, expect, it, vi } from "vitest";
import { STARINTEL_VIEW_MANIFEST, installStarIntelViews, queryCountView } from "./views";

describe("StarIntel map-reduce views", () => {
  it("ships versioned CouchDB-compatible core, relation, target, message, and event views", () => {
    expect(STARINTEL_VIEW_MANIFEST.map((entry) => entry.id)).toEqual([
      "_design/starintel-core-v1",
      "_design/starintel-relations-v1",
      "_design/starintel-targets-v1",
      "_design/starintel-messages-v1",
      "_design/starintel-events-v1"
    ]);
    expect(STARINTEL_VIEW_MANIFEST[1].views.outgoing_count.reduce).toBe("_count");
    expect(STARINTEL_VIEW_MANIFEST[2].views.by_actor.map).toContain("doc.data.actor");
  });

  it("installs missing views and leaves current views alone", async () => {
    const stored = new Map();
    const database = {
      get: vi.fn(async (id) => {
        if (!stored.has(id)) throw Object.assign(new Error("missing"), { status: 404 });
        return stored.get(id);
      }),
      put: vi.fn(async (document) => {
        stored.set(document._id, { ...document, _rev: "1-test" });
        return { ok: true, id: document._id, rev: "1-test" };
      })
    };

    const first = await installStarIntelViews(database);
    const second = await installStarIntelViews(database);

    expect(first.every((item) => item.status === "installed")).toBe(true);
    expect(second.every((item) => item.status === "current")).toBe(true);
    expect(database.put).toHaveBeenCalledTimes(STARINTEL_VIEW_MANIFEST.length);
  });

  it("normalizes grouped count rows", async () => {
    const database = {
      query: vi.fn(async () => ({ rows: [{ key: "person", value: 4 }] }))
    };

    await expect(queryCountView(database, "starintel-core-v1", "dtype_count")).resolves.toEqual([
      { key: "person", count: 4 }
    ]);
    expect(database.query).toHaveBeenCalledWith("starintel-core-v1/dtype_count", {
      group: true,
      reduce: true
    });
  });
});
