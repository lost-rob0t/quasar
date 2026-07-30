import { describe, expect, it } from "vitest";
import { collectImportDocuments } from "../../src/lib/importer.js";

describe("browser import boundary", () => {
  it("reads a standard browser File without a backend", async () => {
    const input = {
      _id: "test:integration",
      dataset: "test",
      dtype: "entity",
      sources: [],
      data: { name: "Quasar" }
    };
    const file = new File([JSON.stringify(input)], "document.json", {
      type: "application/json"
    });

    const result = await collectImportDocuments([file]);

    expect(result.errors).toEqual([]);
    expect(result.files).toEqual(["document.json"]);
    expect(result.documents).toEqual([input]);
  });
});
