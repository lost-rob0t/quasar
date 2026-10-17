import { expect, it, vi } from "vitest";
import { actorIdRecords, prepareActorInput } from "./actor-input";
import { relationsFromRelatedIdsActor } from "../lib/actors-core";
import { toCanonicalDocument } from "../lib/canonical-document";
const source = {
  _id: "starintel:entity:a",
  dtype: "entity",
  dataset: "test",
  schema_version: "0.9.0",
  version: 1,
  date_added: "2026-01-01T00:00:00Z",
  date_updated: "2026-01-01T00:00:00Z",
  title: "A",
  data: { name: "A" },
  related_ids: ["starintel:entity:b"]
};
it("resolves existing generated relation IDs outside the active graph for dedup", async () => {
  const relation = relationsFromRelatedIdsActor({ selection: [source], documents: [source] })
    .operations[0].document;
  const docs = [source, relation].map((doc) => toCanonicalDocument(doc, { allowLegacy090: true }));
  const client = {
    send: vi.fn(async (command, payload) =>
      command === "workspace.bootstrap"
        ? { revision: 7 }
        : {
            revision: 7,
            documents: docs.filter((doc) => payload.ids.includes(doc.id)),
            missingIds: payload.ids.filter((id: string) => !docs.some((doc) => doc.id === id))
          }
    )
  };
  const input = await prepareActorInput(
    client as unknown as Parameters<typeof prepareActorInput>[0],
    { id: "quasar.actor.related-id-relations" },
    [source],
    () => {}
  );
  expect(relationsFromRelatedIdsActor(input).operations).toEqual([]);
  expect(client.send.mock.calls.map(([command]) => command)).toEqual([
    "workspace.bootstrap",
    "document.batch",
    "document.batch"
  ]);
});
it("bounds ID lookup requests and detects missing accounting", async () => {
  const client = {
    send: vi.fn(async (_command, payload) => ({
      revision: 3,
      documents: [],
      missingIds: payload.ids
    }))
  };
  await actorIdRecords(
    client as unknown as Parameters<typeof actorIdRecords>[0],
    Array.from({ length: 101 }, (_, i) => String(i)),
    3,
    () => {}
  );
  expect(client.send.mock.calls.map(([, payload]) => payload.ids.length)).toEqual([50, 50, 1]);
  client.send.mockResolvedValue({ revision: 3, documents: [], missingIds: [] });
  await expect(
    actorIdRecords(
      client as unknown as Parameters<typeof actorIdRecords>[0],
      ["missing"],
      3,
      () => {}
    )
  ).rejects.toThrow("omitted");
});
it("rejects revisions and checks cancellation before reading", async () => {
  const client = { send: vi.fn(async () => ({ revision: 9, documents: [], missingIds: ["a"] })) };
  await expect(
    actorIdRecords(client as unknown as Parameters<typeof actorIdRecords>[0], ["a"], 3, () => {})
  ).rejects.toThrow("revision changed");
  client.send.mockClear();
  await expect(
    actorIdRecords(client as unknown as Parameters<typeof actorIdRecords>[0], ["a"], 3, () => {
      throw new Error("cancelled");
    })
  ).rejects.toThrow("cancelled");
  expect(client.send).not.toHaveBeenCalled();
});
