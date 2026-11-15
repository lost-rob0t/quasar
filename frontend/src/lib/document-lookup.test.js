import { describe, expect, it, vi } from "vitest";
import {
  lookupDocument,
  peekLookupDocument,
  presentDocument,
  resetDocumentLookup
} from "./document-lookup";

function canonical(id) {
  return {
    id,
    dtype: "event",
    dataset: "test",
    schemaVersion: "0.10.1",
    name: `Meeting ${id}`
  };
}

function client({ docs = [], missingIds = [] } = {}) {
  const documentBatch = vi.fn(async (ids) => ({
    documents: docs.filter((document) => ids.includes(document.id)),
    missingIds
  }));
  return { documentBatch };
}

describe("document lookup", () => {
  it("fetches a canonical document by id", async () => {
    resetDocumentLookup();
    const cp = client({ docs: [canonical("p1")] });
    const document = await lookupDocument(cp, "p1");
    expect(document.id).toBe("p1");
    expect(cp.documentBatch).toHaveBeenCalledWith(["p1"]);
  });

  it("returns null when the store reports the document missing", async () => {
    resetDocumentLookup();
    const document = await lookupDocument(client({ missingIds: ["gone"] }), "gone");
    expect(document).toBeNull();
  });

  it("serves repeat lookups from the bounded cache without refetching", async () => {
    resetDocumentLookup();
    const cp = client({ docs: [canonical("p1")] });
    await lookupDocument(cp, "p1");
    const again = await lookupDocument(cp, "p1");
    expect(again.id).toBe("p1");
    expect(cp.documentBatch).toHaveBeenCalledTimes(1);
    expect(peekLookupDocument("p1")?.id).toBe("p1");
  });

  it("evicts the oldest entry beyond the LRU bound", async () => {
    resetDocumentLookup();
    const docs = Array.from({ length: 210 }, (_, index) => canonical(`p${index}`));
    const cp = client({ docs });
    for (let index = 0; index < 210; index += 1) {
      await lookupDocument(cp, `p${index}`);
    }
    expect(peekLookupDocument("p0")).toBeNull();
    expect(peekLookupDocument("p209")?.id).toBe("p209");
  });

  it("throws a clear error without a control plane client", async () => {
    resetDocumentLookup();
    await expect(lookupDocument(null, "p1")).rejects.toThrow("Control plane is unavailable.");
  });

  it("presents canonical records as legacy UI documents and passes them through", () => {
    resetDocumentLookup();
    const legacy = presentDocument({ _id: "p1", dtype: "event" });
    expect(legacy._id).toBe("p1");
    const converted = presentDocument(canonical("p2"));
    expect(converted._id).toBe("p2");
    expect(converted.dtype).toBe("event");
    expect(presentDocument(null)).toBeNull();
  });
});
