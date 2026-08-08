import { describe, expect, it } from "vitest";
import { chunkTransactionOperations } from "./transaction-chunks";

describe("control-plane transaction chunks", () => {
  it("keeps every encoded transaction below the byte limit without reordering operations", () => {
    const operations = Array.from({ length: 12 }, (_, index) => ({
      type: "document.create",
      payload: { _id: `document:${index}`, dtype: "note", data: "x".repeat(700) }
    }));
    const chunks = chunkTransactionOperations(operations, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(operations);
    for (const chunk of chunks) {
      expect(
        new TextEncoder().encode(JSON.stringify({ operations: chunk })).byteLength
      ).toBeLessThan(4096);
    }
  });

  it("rejects a single document that cannot fit in one transaction", () => {
    expect(() =>
      chunkTransactionOperations(
        [{ type: "document.create", payload: { data: "x".repeat(3000) } }],
        4096
      )
    ).toThrow(/document exceeds/i);
  });
});
