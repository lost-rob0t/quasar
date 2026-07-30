import { describe, expect, it } from "vitest";
import { buildAgentContext } from "./agent-context";

describe("agent context", () => {
  it("includes scoped records instead of dumping the database", () => {
    const documents = Array.from({ length: 100 }, (_, index) => ({
      _id: `person:${index}`,
      dataset: "alpha",
      dtype: "person",
      title: `Person ${index}`,
      data: {},
      sources: []
    }));
    const context = buildAgentContext(
      {
        documents,
        selectionIds: ["person:10"],
        targetIds: [],
        dataset: "alpha"
      },
      { maxDocuments: 5 }
    );
    expect(context.documents).toHaveLength(1);
    expect(context.documents[0].id).toBe("person:10");
  });
});
