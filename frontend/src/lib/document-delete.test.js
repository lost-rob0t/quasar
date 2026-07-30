import { describe, expect, it } from "vitest";
import { connectedDocumentIds } from "./document-delete";

describe("connected document deletion", () => {
  const documents = [
    { _id: "person:a", dtype: "person", data: {} },
    { _id: "person:b", dtype: "person", data: {} },
    {
      _id: "relation:a-b",
      dtype: "relation",
      data: { subject: "person:a", object: "person:b", predicate: "knows" }
    },
    {
      _id: "relation:claim-edge",
      dtype: "relation",
      data: { subject: "relation:a-b", object: "person:b", predicate: "supports" }
    }
  ];

  it("includes relations attached to a deleted document", () => {
    expect(new Set(connectedDocumentIds(documents, ["person:a"]))).toEqual(
      new Set(["person:a", "relation:a-b", "relation:claim-edge"])
    );
  });

  it("keeps unrelated documents", () => {
    expect(connectedDocumentIds(documents, ["person:b"])).not.toContain("person:a");
  });

  it("deduplicates requested IDs", () => {
    expect(connectedDocumentIds(documents, ["person:a", "person:a"])[0]).toBe("person:a");
  });
});
