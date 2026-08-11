import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ current: null }));
vi.mock("../store", () => ({ useQuasar: () => context.current }));
vi.mock("../lib/operations", () => ({
  operation: {
    save: (value) => ({ type: "save-document", document: value })
  }
}));

import GraphPage from "./GraphPage";

const stamp = "2026-07-25T20:00:00.000Z";
const document = (id, dtype, data, verified) => ({
  _id: id,
  dataset: "test",
  dtype,
  schema_version: "0.9.0",
  version: 1,
  date_added: stamp,
  date_updated: stamp,
  title: id,
  sources: [],
  evidence: [],
  verification: { verified, status: verified ? "verified" : "unverified" },
  data
});

describe("graph local corpus status", () => {
  it("names hidden URL filters and offers to restore every graph node", () => {
    const documents = [
      document("starintel:org:alpha", "org", { name: "Alpha" }, true),
      document("starintel:org:beta", "org", { name: "Beta" }, true)
    ];
    context.current = {
      documents,
      workspace: { positions: {}, layout: "cose" },
      selectedIds: [],
      selectedDocuments: [],
      select: vi.fn(),
      persistWorkspace: vi.fn(),
      actors: [],
      runActor: vi.fn(),
      settings: { actorsEnabled: false },
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/graph?dataset=missing"]}>
        <Routes>
          <Route path="/graph" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Hidden by dataset “missing”.");
    expect(html).toContain("Show all 2 documents");
  });

  it("offers manual creation from an empty graph", () => {
    context.current = {
      documents: [],
      workspace: { positions: {}, layout: "cose" },
      selectedIds: [],
      selectedDocuments: [],
      select: vi.fn(),
      persistWorkspace: vi.fn(),
      actors: [],
      runActor: vi.fn(),
      settings: { actorsEnabled: false },
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route path="/graph" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Start a blank graph");
    expect(html).toContain("Right-click anywhere to create the first node");
    expect(html).toContain("Create first node");
    expect(html).toContain("Import documents");
    expect(html).toContain("Enter blank canvas");
  });

  it("reveals why newly-created unreviewed nodes are hidden", () => {
    const documents = [document("starintel:entity:manual", "entity", { name: "Manual" }, false)];
    context.current = {
      documents,
      workspace: { positions: {}, layout: "cose" },
      selectedIds: [],
      selectedDocuments: [],
      select: vi.fn(),
      persistWorkspace: vi.fn(),
      actors: [],
      runActor: vi.fn(),
      settings: { actorsEnabled: false },
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route path="/graph" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("1 unreviewed document(s) are hidden");
    expect(html).toContain("Show unreviewed");
    expect(html).toContain("Create first node");
  });

  it("reveals imported unreviewed records and reports corpus review counts", () => {
    const documents = [
      document("starintel:org:reviewed", "org", { name: "Reviewed" }, true),
      document("starintel:org:imported", "org", { name: "Imported" }, false),
      document(
        "starintel:relation:imported",
        "relation",
        {
          subject: "starintel:org:reviewed",
          predicate: "related-to",
          object: "starintel:org:imported",
          directed: true
        },
        false
      )
    ];
    context.current = {
      documents,
      workspace: { positions: {}, layout: "cose" },
      selectedIds: [],
      selectedDocuments: [],
      select: vi.fn(),
      persistWorkspace: vi.fn(),
      actors: [],
      runActor: vi.fn(),
      settings: { actorsEnabled: false },
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/graph",
            state: {
              importedIds: ["starintel:org:imported", "starintel:relation:imported"],
              revealUnreviewed: true,
              source: "local-import"
            }
          }
        ]}
      >
        <Routes>
          <Route path="/graph" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Local PouchDB corpus");
    expect(html).toContain("1 reviewed");
    expect(html).toContain("2 unreviewed");
    expect(html).toContain("Imported records are revealed for this graph session");
    expect(html).toContain("2 nodes");
    expect(html).toContain("1 edges");
  });

  it("shows research node state and execution scope in the inspector", () => {
    const researchNode = {
      ...document(
        "starintel:research-node:map",
        "research-node",
        {
          objective: "Map the network",
          status: "paused",
          input_ids: ["starintel:org:input"],
          target_ids: [],
          actor_ids: ["actor:search"],
          actor_selection_rules: [],
          output_ids: ["starintel:org:output"],
          artifact_ids: [],
          child_ids: [],
          dependency_ids: [],
          run_ids: [],
          current_actor_id: "",
          current_run_id: "",
          limits: {},
          stop: {},
          counters: {},
          history: [],
          created_at: stamp,
          started_at: null,
          completed_at: null,
          last_error: "",
          paused_reason: "operator"
        },
        true
      ),
      status: "paused",
      summary: "Map the network"
    };
    context.current = {
      documents: [researchNode],
      workspace: { positions: {}, layout: "cose" },
      selectedIds: [researchNode._id],
      selectedDocuments: [researchNode],
      select: vi.fn(),
      persistWorkspace: vi.fn(),
      actors: [],
      runActor: vi.fn(),
      settings: { actorsEnabled: false },
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route path="/graph" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Research state: paused");
    expect(html).toContain("1 inputs · 1 outputs · 1 actors");
    expect(html).toContain("Resume</button>");
    expect(html).toContain("Kill</button>");
    expect(html).toContain("Outputs</button>");
  });

  it("renders named graphs as a persistent workbench list", () => {
    const documents = [
      { ...document("starintel:org:first", "org", { name: "First" }, true), dataset: "alpha" },
      {
        ...document("starintel:person:second", "person", { name: "Second" }, true),
        dataset: "beta"
      }
    ];
    const allGraph = {
      id: "all-documents",
      name: "All documents",
      documentIds: null,
      positions: {},
      viewport: null,
      layout: "cose",
      selectedIds: []
    };
    const customGraph = {
      id: "cross-dataset-case",
      name: "Cross-dataset case",
      documentIds: documents.map((item) => item._id),
      positions: {},
      viewport: null,
      layout: "cose",
      selectedIds: []
    };
    context.current = {
      documents,
      workspace: {
        graphs: [allGraph, customGraph],
        activeGraphId: customGraph.id,
        positions: {},
        viewport: null,
        layout: "cose",
        selectedIds: []
      },
      graphs: [allGraph, customGraph],
      activeGraph: customGraph,
      selectedIds: [],
      selectedDocuments: [],
      select: vi.fn(),
      persistWorkspace: vi.fn(),
      actors: [],
      runActor: vi.fn(),
      settings: { actorsEnabled: false },
      setNotice: vi.fn(),
      switchGraph: vi.fn(),
      renameGraph: vi.fn(),
      deleteGraph: vi.fn(),
      createGraph: vi.fn()
    };

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/graph"]}>
        <Routes>
          <Route path="/graph" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain('aria-label="Graphs"');
    expect(html).toContain('aria-label="Open graph"');
    expect(html).toContain('value="cross-dataset-case" selected=""');
    expect(html).toContain("All documents");
    expect(html).toContain("Entire corpus");
    expect(html).toContain("Cross-dataset case");
    expect(html).toContain("2 documents");
    expect(html).toContain('aria-current="page"');
  });
});
