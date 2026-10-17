import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const cp = vi.hoisted(() => ({
  cpDocumentCreate: vi.fn(),
  cpDocumentUpdate: vi.fn(),
  cpDocumentDelete: vi.fn(),
  cpImportDocuments: vi.fn(),
  cpSnapshot: vi.fn(),
  cpTransaction: vi.fn()
}));
vi.mock("./control-plane/mutations", () => cp);
const client = vi.hoisted(() => ({
  send: vi.fn(),
  transaction: vi.fn(),
  onConnectionStateChange: (listener) => {
    listener({ synchronized: true });
    return () => {};
  }
}));
vi.mock("./control-plane/client", () => ({ getControlPlane: () => client }));
vi.mock("./lib/db", () => ({
  databaseInfo: vi.fn(),
  ensureStarIntelViews: vi.fn(),
  initializeSettings: vi.fn(),
  listDocuments: vi.fn(),
  replaceDocumentProjection: vi.fn(),
  saveSettings: vi.fn(),
  startLiveSync: vi.fn(),
  syncOnce: vi.fn()
}));
vi.mock("./lib/actors", () => ({
  BUILTIN_ACTORS: [],
  actorApplicability: vi.fn(),
  actorsForTarget: vi.fn(),
  isBuiltinActor: vi.fn(),
  runBrowserActor: vi.fn()
}));
import { QuasarProvider, useQuasar } from "./store";
import { toLegacyUiDocument } from "./lib/canonical-document";
let context;
function Capture() {
  context = useQuasar();
  return null;
}
const document = {
  id: "event:provider",
  dtype: "event",
  dataset: "test",
  schemaVersion: "0.10.1",
  name: "Meeting"
};
beforeEach(() => {
  vi.clearAllMocks();
  let current = null;
  let revision = 0;
  client.send.mockImplementation(async (command, payload) => {
    if (command === "workspace.bootstrap") return { revision };
    if (command === "document.batch") {
      expect(payload.expectedRevision).toBe(revision);
      return {
        revision,
        documents: current ? [current] : [],
        missingIds: current ? [] : [document.id]
      };
    }
    throw new Error(`Unexpected read ${command}`);
  });
  client.transaction.mockImplementation(async (operations, expectedRevision) => {
    expect(expectedRevision).toBe(revision);
    current = operations[0].payload;
    revision += 1;
    return { revision, results: [{ revision }] };
  });
  cp.cpSnapshot.mockResolvedValue({ documents: [toLegacyUiDocument(document)], graphs: [] });
  cp.cpTransaction.mockResolvedValue({ revision: 1 });
  renderToStaticMarkup(
    <QuasarProvider>
      <Capture />
    </QuasarProvider>
  );
});
it("uses canonical IDs for create and subsequent update in the actual provider", async () => {
  await context.execute({ type: "save-document", document });
  expect(client.transaction).toHaveBeenNthCalledWith(
    1,
    [{ type: "document.create", payload: document }],
    0
  );
  await context.execute({ type: "save-document", document: { ...document, name: "Updated" } });
  expect(client.transaction).toHaveBeenNthCalledWith(
    2,
    [{ type: "document.update", payload: { ...document, name: "Updated" } }],
    1
  );
  expect(client.send.mock.calls.filter(([command]) => command === "document.batch")).toHaveLength(
    2
  );
  expect(cp.cpDocumentCreate).not.toHaveBeenCalled();
  expect(cp.cpDocumentUpdate).not.toHaveBeenCalled();
});
it("strips storage metadata before provider batch transport", async () => {
  const report = await context.executeBatch([document]);
  expect(cp.cpTransaction).toHaveBeenCalledTimes(1);
  const payload = cp.cpTransaction.mock.calls[0][0][0].payload;
  expect(payload.id).toBe(document.id);
  expect(payload).not.toHaveProperty("_id");
  expect(payload).not.toHaveProperty("data");
  expect(report.saved[0].id).toBe(document.id);
});

it("keeps repeated transaction touches ordered using only canonical preflight state", async () => {
  await context.execute({
    type: "batch",
    operations: [
      { type: "save-document", document },
      { type: "remove-document", id: document.id },
      { type: "save-document", document: { ...document, name: "again" } }
    ]
  });
  expect(cp.cpTransaction).toHaveBeenCalledWith(
    [
      { type: "document.create", payload: document },
      { type: "document.delete", payload: { id: document.id } },
      { type: "document.create", payload: { ...document, name: "again" } }
    ],
    0
  );
  expect(client.send.mock.calls.filter(([command]) => command === "document.batch")).toHaveLength(
    1
  );
});
it("skip-existing policy uses canonical presence even when the provider cache is empty", async () => {
  client.send
    .mockResolvedValueOnce({ revision: 4 })
    .mockResolvedValueOnce({ revision: 4, documents: [document], missingIds: [] });
  const report = await context.executeBatch([document], "Skip existing", { replace: false });
  expect(report.saved).toEqual([]);
  expect(report.skipped).toEqual([{ id: document.id, reason: "exists" }]);
  expect(cp.cpTransaction).not.toHaveBeenCalled();
});

it("rejects a relation deletion plan if its revision changed before commit", async () => {
  await expect(
    context.execute(
      { type: "batch", operations: [{ type: "remove-document", id: "event:provider" }] },
      "Delete related documents",
      { expectedRevision: 999 }
    )
  ).rejects.toThrow("Documents changed");
  expect(cp.cpTransaction).not.toHaveBeenCalled();
});
