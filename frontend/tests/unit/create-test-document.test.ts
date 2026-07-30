import { describe, expect, it } from "vitest";
import { createTestDocument } from "../../src/testing";

describe("test document factory", () => {
  it("creates a canonical typed document with explicit overrides", () => {
    const document = createTestDocument({ _id: "test:unit", title: "Quasar" });

    expect(document).toMatchObject({
      _id: "test:unit",
      title: "Quasar",
      dataset: "test",
      sources: []
    });
  });
});
