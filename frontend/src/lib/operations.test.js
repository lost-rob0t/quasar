import { beforeEach, describe, expect, it, vi } from "vitest";

const controlPlane = vi.hoisted(() => ({
  cpSnapshot: vi.fn(),
  cpTransaction: vi.fn()
}));

vi.mock("../control-plane/mutations", () => controlPlane);

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
    controlPlane.cpSnapshot.mockResolvedValue({ documents: [] });
    controlPlane.cpTransaction.mockResolvedValue({ revision: 1, results: [] });
  });

  it("returns an undo operation for every committed document", async () => {
    const applied = await saveDocumentBatch([document], "Import");
    expect(controlPlane.cpTransaction).toHaveBeenCalledWith([
      {
        type: "document.create",
        payload: expect.objectContaining({ _id: document._id, dtype: "org" })
      }
    ]);
    expect(applied.inverse.operations).toEqual([{ type: "remove-document", id: document._id }]);
  });

  it("does not submit an atomic batch when validation fails", async () => {
    await expect(
      saveDocumentBatch([document, { _id: "invalid", dtype: "not-a-real-dtype" }], "Import")
    ).rejects.toMatchObject({ report: { atomic: true, saved: [] } });
    expect(controlPlane.cpTransaction).not.toHaveBeenCalled();
  });
});
