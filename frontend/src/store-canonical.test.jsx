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
  getConnected: vi.fn(() => false),
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
  client.getConnected.mockReturnValue(false);
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

it("actual provider startup requests only bootstrap and compact catalog, never saved graph content", async () => {
  client.getConnected.mockReturnValue(true);
  client.send.mockImplementation(async (command) => {
    if (command === "workspace.bootstrap") return { revision: 4, documentCount: 100000 };
    if (command === "graph.catalog")
      return {
        revision: 4,
        projection: "graph-catalog.v1",
        graphs: [
          { id: "huge", name: "Saved huge graph", membershipMode: "all", documentCount: 100000 }
        ],
        savedGraphId: "huge",
        complete: true,
        cursor: null
      };
    throw new Error(`Unexpected eager read ${command}`);
  });
  await context.refresh();
  expect(client.send.mock.calls.map(([command]) => command)).toEqual([
    "workspace.bootstrap",
    "graph.catalog"
  ]);
  expect(cp.cpSnapshot).not.toHaveBeenCalled();
  expect(client.transaction).not.toHaveBeenCalled();
});

it("opening a graph only activates it; subsequent rename preserves unknown metadata and containers", async () => {
  const graph = { id: "small", name: "Saved graph", custom: { keep: true } };
  client.send.mockImplementation(async (command, payload) => {
    if (command === "workspace.bootstrap") return { revision: 4, documentCount: 0 };
    if (command === "graph.page")
      return {
        revision: 4,
        projection: "graph-page.v1",
        graphId: "small",
        section: payload.section,
        records:
          payload.section === "descriptor"
            ? [
                {
                  metadata: graph,
                  collectionKinds: {
                    documentIds: "array",
                    positions: "null",
                    groups: "array",
                    selectedIds: "array"
                  }
                }
              ]
            : payload.section === "groups"
              ? [{ index: 0, value: { custom: "group" } }]
              : [],
        complete: true,
        cursor: null
      };
    throw new Error(command);
  });
  client.transaction.mockResolvedValue({ revision: 5 });
  await context.switchGraph("small");
  expect(client.transaction).toHaveBeenCalledWith(
    [{ type: "graph.activate", payload: { id: "small" } }],
    4
  );
  expect(cp.cpTransaction).not.toHaveBeenCalled();
  context.renameGraph("Renamed");
  await context.flushWorkspace();
  expect(cp.cpTransaction).toHaveBeenCalledWith(
    [
      {
        type: "graph.put",
        payload: {
          ...graph,
          name: "Renamed",
          documentIds: [],
          positions: null,
          groups: [{ custom: "group" }],
          selectedIds: [],
          nodes: [],
          edges: []
        }
      },
      { type: "graph.activate", payload: { id: "small" } }
    ],
    5
  );
});
it("returns a successful edit even if metadata refresh fails after commit", async () => {
  client.getConnected.mockReturnValue(true);
  await expect(
    context.execute({ type: "save-document", document, intent: "create" })
  ).resolves.toEqual({ revision: 1 });
  expect(client.transaction).toHaveBeenCalledOnce();
});
