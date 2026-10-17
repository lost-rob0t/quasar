import { ControlPlaneError } from "./protocol";
import { expect, it, vi } from "vitest";
import { matchesDocument, readDocumentListPage } from "./document-list";
const scope = { q: "", dtype: "", dataset: "" };
const document = (id: string) => ({
  id,
  dtype: "person",
  dataset: "main",
  schemaVersion: "0.10.1",
  fullName: id
});
function client(pages: unknown[]) {
  const send = vi.fn(async (command: string) =>
    command === "system.capabilities" ? ["document.page"] : pages.shift()
  );
  return { send } as unknown as Parameters<typeof readDocumentListPage>[0];
}
it("preserves nested data and source search semantics", () => {
  const doc = {
    ...document("person:a"),
    extensions: { quasarLegacy090: { data: { custom: { text: "Nested Needle" } } } }
  };
  expect(matchesDocument(doc, { ...scope, q: "nested needle" })).toBe(true);
  expect(matchesDocument(doc, { ...scope, dataset: "elsewhere" })).toBe(false);
});
it("continues empty filtered canonical pages without losing matches", async () => {
  const c = client([
    { revision: 4, documents: [document("person:a")], complete: false, cursor: "next" },
    { revision: 4, documents: [document("person:needle")], complete: true, cursor: null }
  ]);
  expect(
    await readDocumentListPage(c, { ...scope, q: "needle" }, 4, null, 50, () => {})
  ).toMatchObject({ documents: [document("person:needle")], complete: true });
});
it("keeps a continuation when the bounded scan budget is exhausted", async () => {
  const pages = Array.from({ length: 20 }, (_, index) => ({
    revision: 4,
    documents: Array.from({ length: 50 }, (_, n) => document(`person:${index}-${n}`)),
    complete: false,
    cursor: `cursor${index}`
  }));
  const result = await readDocumentListPage(
    client(pages),
    { ...scope, q: "absent" },
    4,
    null,
    50,
    () => {}
  );
  expect(result.documents).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.cursor).not.toBeNull();
});
it("rejects stale revisions and malformed continuations", async () => {
  for (const value of [
    { revision: 5, documents: [], complete: true, cursor: null },
    { revision: 4, documents: [], complete: false, cursor: "same" }
  ]) {
    await expect(
      readDocumentListPage(client([value]), scope, 4, "same", 50, () => {})
    ).rejects.toThrow();
  }
});
it("does not pull another page after cancellation", async () => {
  const c = client([{ revision: 4, documents: [], complete: false, cursor: "next" }]);
  let checks = 0;
  await expect(
    readDocumentListPage(c, scope, 4, null, 50, () => {
      if (++checks === 4) throw new Error("cancelled");
    })
  ).rejects.toThrow("cancelled");
  expect(c.send).toHaveBeenCalledTimes(2);
});

it("returns retained matches before a record that needs a fresh page byte budget", async () => {
  let pages = 0;
  const c = {
    send: async (command: string) => {
      if (command === "system.capabilities") return ["document.page"];
      if (pages++) throw new ControlPlaneError("query.record-too-large", "Needs full budget");
      return {
        revision: 4,
        documents: [document("person:a")],
        complete: false,
        cursor: "resume-before-large"
      };
    }
  } as unknown as Parameters<typeof readDocumentListPage>[0];
  expect(await readDocumentListPage(c, scope, 4, null, 50, () => {})).toMatchObject({
    documents: [document("person:a")],
    cursor: "resume-before-large",
    complete: false
  });
});
