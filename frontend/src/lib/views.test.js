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

  it("reconciles a conflict only when the winning definition is current", async () => {
    const first = STARINTEL_VIEW_MANIFEST[0];
    const current = (id) => {
      const entry = STARINTEL_VIEW_MANIFEST.find((item) => item.id === id);
      return { _id: id, _rev: "2-winner", quasar_view_version: entry.version, views: entry.views };
    };
    const database = {
      get: vi
        .fn()
        .mockRejectedValueOnce({ status: 404 })
        .mockImplementation(async (id) => current(id)),
      put: vi.fn().mockRejectedValue({ status: 409 })
    };
    await expect(installStarIntelViews(database)).resolves.toContainEqual({
      id: first.id,
      status: "current"
    });
    expect(database.put).toHaveBeenCalledTimes(1);
    expect(database.get).toHaveBeenCalledTimes(STARINTEL_VIEW_MANIFEST.length + 1);
  });

  it("does not overwrite a different concurrent definition or retry its conflict", async () => {
    const conflict = Object.assign(new Error("Document update conflict"), { status: 409 });
    const database = {
      get: vi
        .fn()
        .mockRejectedValueOnce({ status: 404 })
        .mockResolvedValue({
          _rev: "1-other",
          quasar_view_version: 999,
          views: { custom: { map: "function (doc) { emit(doc._id); }" } }
        }),
      put: vi.fn().mockRejectedValue(conflict)
    };
    await expect(installStarIntelViews(database)).rejects.toBe(conflict);
    expect(database.put).toHaveBeenCalledTimes(1);
    expect(database.get).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 500])("preserves a genuine %s installation failure", async (status) => {
    const failure = Object.assign(new Error("Installation unavailable"), { status });
    const database = {
      get: vi.fn().mockRejectedValue({ status: 404 }),
      put: vi.fn().mockRejectedValue(failure)
    };
    await expect(installStarIntelViews(database)).rejects.toBe(failure);
    expect(database.put).toHaveBeenCalledTimes(1);
    expect(database.get).toHaveBeenCalledTimes(1);
  });

  it("preserves a failed reconciliation read", async () => {
    const failure = Object.assign(new Error("Read unavailable"), { status: 503 });
    const database = {
      get: vi.fn().mockRejectedValueOnce({ status: 404 }).mockRejectedValue(failure),
      put: vi.fn().mockRejectedValue({ status: 409 })
    };
    await expect(installStarIntelViews(database)).rejects.toBe(failure);
    expect(database.put).toHaveBeenCalledTimes(1);
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
