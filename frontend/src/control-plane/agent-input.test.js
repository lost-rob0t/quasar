import { expect, it } from "vitest";
import {
  transformationEvidence,
  canonicalAgentContext,
  queryCanonicalDocuments
} from "./agent-input";
const document = (id) => ({
  id,
  dataset: "test",
  dtype: "entity",
  schemaVersion: "0.10.1",
  name: id
});
function client(documents) {
  return {
    onConnectionStateChange: () => () => {},
    exportDocuments: async (sink) => {
      try {
        for (const doc of documents) await sink.write(doc);
        await sink.close();
        return { revision: 7 };
      } catch (error) {
        await sink.abort(error);
        throw error;
      }
    }
  };
}
it("keeps corpus-wide linked/touched evidence outside the requested graph without retaining bodies", async () => {
  const cp = client([
    {
      ...document("output"),
      extensions: { "quasar.actor": { actor_id: "actor", input_ids: ["selected"] } }
    },
    {
      id: "edge",
      dataset: "test",
      schemaVersion: "0.10.1",
      dtype: "relation",
      source: { schema: "org.starintel/core@1/document", id: "selected" },
      destination: { schema: "org.starintel/core@1/document", id: "other" },
      predicate: "knows"
    }
  ]);
  const evidence = await transformationEvidence(cp, ["selected"], "actor");
  expect([...evidence.touched]).toEqual(["selected"]);
  expect([...evidence.linked]).toEqual(["selected"]);
});
it("counts all agent candidates while retaining only the prompt budget", async () => {
  const docs = Array.from({ length: 100 }, (_, i) => document(`e${i}`));
  const context = await canonicalAgentContext(client(docs), {
    selectionIds: docs.map((doc) => doc.id)
  });
  expect(context.documents).toHaveLength(30);
  expect(context.limits.candidateDocuments).toBe(100);
  expect(context.limits.truncated).toBe(true);
});
it("distinguishes an intentionally bounded query from a mutation requiring a complete match", async () => {
  const cp = client(Array.from({ length: 3 }, (_, i) => document(`e${i}`)));
  expect((await queryCanonicalDocuments(cp, () => true, 2)).documents).toHaveLength(2);
  await expect(
    queryCanonicalDocuments(cp, () => true, 2, { requireComplete: true })
  ).rejects.toThrow("document budget");
});
