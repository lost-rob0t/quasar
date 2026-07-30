import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  bulkSaveDocuments: vi.fn(),
  getDocument: vi.fn(),
  removeDocument: vi.fn(),
  saveDocument: vi.fn()
}));

vi.mock("./db", () => database);

import { saveDocumentBatch } from "./operations";

const stamp = "2026-07-25T20:00:00.000Z";
const document = {
  _id: "starintel:org:test",
  dataset: "test",
  dtype: "org",
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: "Test",
  sources: [],
  evidence: [],
  data: { name: "Test" }
};

describe("batch operation history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.getDocument.mockResolvedValue(null);
  });

  it("returns an undo operation for every committed document", async () => {
    database.bulkSaveDocuments.mockResolvedValue({
      saved: [{ index: 0, id: document._id, rev: "1-a" }],
      skipped: [],
      errors: []
    });

    const applied = await saveDocumentBatch([document], "Import");
    expect(applied.inverse.operations).toEqual([{ type: "remove-document", id: document._id }]);
  });

  it("exposes an undo operation even when a failed rollback leaves a write committed", async () => {
    database.bulkSaveDocuments.mockResolvedValue({
      saved: [{ index: 0, id: document._id, rev: "1-a" }],
      skipped: [],
      errors: [{ index: 1, id: "starintel:org:failed", message: "write failed" }]
    });

    try {
      await saveDocumentBatch([document], "Import");
      throw new Error("expected saveDocumentBatch to reject");
    } catch (error) {
      expect(error.report.saved[0].id).toBe(document._id);
      expect(error.applied.inverse.operations).toEqual([
        { type: "remove-document", id: document._id }
      ]);
    }
  });
});
