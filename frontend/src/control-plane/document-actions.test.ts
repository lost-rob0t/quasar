import { expect, it, vi } from "vitest";
import { relatedDeletionIds, graphDocumentsForScope } from "./document-actions";
import type { ControlPlaneClient } from "./client";
const doc = (id: string, rest = {}) => ({
  id,
  dtype: "person",
  dataset: "main",
  schemaVersion: "0.10.1",
  ...rest
});
function fixture(documents: Record<string, unknown>[]) {
  const exportDocuments = vi.fn(
    async (sink: {
      write: (d: Record<string, unknown>) => Promise<void>;
      close: () => Promise<void>;
    }) => {
      for (const document of documents) await sink.write(document);
      await sink.close();
      return { count: documents.length, revision: 4 };
    }
  );
  return { exportDocuments } as unknown as ControlPlaneClient;
}
it("resolves relation closure even when dependent relations precede their targets", async () => {
  const c = fixture([
    doc("relation:outer", {
      dtype: "relation",
      predicate: "related",
      source: { schema: "org.starintel/core@1/document", id: "relation:inner" },
      destination: { schema: "org.starintel/core@1/document", id: "person:x" }
    }),
    doc("relation:inner", {
      dtype: "relation",
      predicate: "related",
      source: { schema: "org.starintel/core@1/document", id: "person:target" },
      destination: { schema: "org.starintel/core@1/document", id: "person:y" }
    }),
    doc("person:target")
  ]);
  expect(await relatedDeletionIds(c, "person:target")).toEqual({
    ids: ["person:target", "relation:inner", "relation:outer"],
    revision: 4
  });
  expect(c.exportDocuments).toHaveBeenCalledTimes(3);
});
it("rejects a graph selection beyond renderer limits rather than truncating", async () => {
  const c = fixture(Array.from({ length: 2001 }, (_, n) => doc(`person:${n}`)));
  await expect(graphDocumentsForScope(c, { q: "", dtype: "", dataset: "" })).rejects.toThrow(
    /Narrow/
  );
});
it("selects all matching graph results instead of only the visible page", async () => {
  const c = fixture([doc("person:a"), doc("person:b", { dataset: "elsewhere" })]);
  expect(
    (await graphDocumentsForScope(c, { q: "", dtype: "", dataset: "main" })).map((d) => d._id)
  ).toEqual(["person:a"]);
});
