import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store", () => ({ useQuasar: vi.fn() }));
vi.mock("./AgentSystem", () => ({ useAgentSystem: vi.fn() }));

import { useQuasar } from "../store";
import { useAgentSystem } from "./AgentSystem";
import GraphWorkspaceChrome from "./GraphWorkspaceChrome";

const documents = [
  {
    _id: "person:one",
    title: "First person",
    dtype: "person",
    dataset: "case-alpha",
    date_updated: "2026-07-28T08:00:00.000Z",
    verification: { verified: true }
  },
  {
    _id: "org:one",
    title: "First organization",
    dtype: "org",
    dataset: "case-alpha",
    date_updated: "2026-07-28T07:00:00.000Z",
    verification: { verified: false }
  },
  {
    _id: "relation:one",
    title: "Person linked to organization",
    dtype: "relation",
    dataset: "case-alpha",
    date_updated: "2026-07-28T06:00:00.000Z",
    verification: { verified: true }
  }
];

beforeEach(() => {
  useQuasar.mockReturnValue({
    documents,
    graphs: [
      {
        id: "case-alpha",
        name: "Case Alpha",
        documentIds: documents.map((document) => document._id)
      }
    ],
    activeGraph: {
      id: "case-alpha",
      name: "Case Alpha",
      documentIds: documents.map((document) => document._id)
    },
    switchGraph: vi.fn(),
    createGraph: vi.fn(),
    syncStatus: { state: "ready" }
  });
  useAgentSystem.mockReturnValue({
    activeAgent: { id: "operator", name: "Operator", modelId: "local/test" },
    activeRun: null,
    command: vi.fn()
  });
});

describe("graph workspace chrome", () => {
  it("renders graph tabs, live metrics, agent controls, and recent activity", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/graph"]}>
        <GraphWorkspaceChrome />
      </MemoryRouter>
    );

    expect(html).toContain("Case Alpha");
    expect(html).toContain("Graph statistics");
    expect(html).toContain("<span>Nodes</span><strong>2</strong>");
    expect(html).toContain("<span>Edges</span><strong>1</strong>");
    expect(html).toContain("<span>Documents</span><strong>3</strong>");
    expect(html).toContain("<span>Reviewed</span><strong>67%</strong>");
    expect(html).toContain("Operator");
    expect(html).toContain("Find missing connections");
    expect(html).toContain("First person");
  });

  it("stays out of non-graph routes", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/documents"]}>
        <GraphWorkspaceChrome />
      </MemoryRouter>
    );

    expect(html).toBe("");
  });
});
