import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// Undo preimages must resolve through direct lookups when the corpus does
// not contain the record: an update against a server-known document must be
// recorded as update+inverse, not create.
const client = vi.hoisted(() => ({
  documentBatch: vi.fn(async (ids) => ({
    documents: ids.includes("known:1")
      ? [
          {
            id: "known:1",
            dtype: "event",
            dataset: "test",
            schemaVersion: "0.10.1",
            name: "Existing"
          }
        ]
      : [],
    missingIds: ids.filter((id) => id !== "known:1")
  }))
}));
const mutations = vi.hoisted(() => ({
  cpDocumentCreate: vi.fn(async (document) => ({ id: document.id })),
  cpDocumentUpdate: vi.fn(async (document) => ({ id: document.id })),
  cpDocumentDelete: vi.fn(async () => ({})),
  cpImportDocuments: vi.fn(async () => ({})),
  cpSnapshot: vi.fn(async () => ({ documents: [], graphs: [] })),
  cpTransaction: vi.fn(async (ops) => ({ ops }))
}));
vi.mock("./control-plane/mutations", () => mutations);
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
import { resetDocumentLookup } from "./lib/document-lookup";

let context;
function Capture() {
  context = useQuasar();
  return null;
}

function render() {
  return renderToStaticMarkup(
    <QuasarProvider>
      <Capture />
    </QuasarProvider>
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetDocumentLookup();
  mutations.cpSnapshot.mockResolvedValue({ documents: [], graphs: [] });
  render();
  await vi.waitFor(() => expect(context).toBeTruthy());
});

it("updates and records an inverse for a server-known document missing from the corpus", async () => {
  const document = {
    id: "known:1",
    dtype: "event",
    dataset: "test",
    schemaVersion: "0.10.1",
    name: "Existing"
  };
  await context.execute({ type: "save-document", document: { ...document, name: "Updated" } });
  expect(mutations.cpDocumentUpdate).toHaveBeenCalled();
  expect(mutations.cpDocumentCreate).not.toHaveBeenCalled();
});

it("creates a document the store does not know about", async () => {
  await context.execute({
    type: "save-document",
    document: {
      id: "unknown:1",
      dtype: "event",
      dataset: "test",
      schemaVersion: "0.10.1",
      name: "New"
    }
  });
  expect(mutations.cpDocumentCreate).toHaveBeenCalled();
  expect(mutations.cpDocumentUpdate).not.toHaveBeenCalled();
});

it("resolves a remove preimage via direct lookup for undo", async () => {
  await context.execute({ type: "remove-document", id: "known:1" });
  expect(mutations.cpDocumentDelete).toHaveBeenCalledWith("known:1");
});
