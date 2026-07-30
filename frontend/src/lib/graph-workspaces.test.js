import { describe, expect, it } from "vitest";
import {
  activeGraphMembershipKey,
  addDocumentsToActiveGraph,
  clearActiveGraph,
  createGraph,
  deleteActiveGraph,
  documentsForActiveGraph,
  getActiveGraph,
  normalizeGraphWorkspace,
  removeDocumentsFromActiveGraph,
  renameActiveGraph,
  switchActiveGraph,
  updateActiveGraph
} from "./graph-workspaces";

describe("graph workspaces", () => {
  it("migrates the legacy single graph to an all-documents graph", () => {
    const workspace = normalizeGraphWorkspace({
      positions: { a: { x: 1, y: 2 } },
      layout: "grid",
      selectedIds: ["a"]
    });

    expect(workspace.graphs).toEqual([
      {
        id: "all-documents",
        name: "All documents",
        documentIds: null,
        positions: { a: { x: 1, y: 2 } },
        viewport: null,
        layout: "grid",
        selectedIds: ["a"]
      }
    ]);
    expect(workspace.activeGraphId).toBe("all-documents");
  });

  it("creates and switches independent blank graphs", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    expect(getActiveGraph(workspace)).toMatchObject({
      id: "case-alpha",
      name: "Case Alpha",
      documentIds: []
    });

    workspace = addDocumentsToActiveGraph(workspace, ["person:a", "relation:a-b"], {
      selectedIds: ["person:a"]
    });
    workspace = createGraph(workspace, "Case Beta", { id: "case-beta" });
    expect(getActiveGraph(workspace).documentIds).toEqual([]);

    workspace = switchActiveGraph(workspace, "case-alpha");
    expect(getActiveGraph(workspace).documentIds).toEqual(["person:a", "relation:a-b"]);
    expect(workspace.selectedIds).toEqual(["person:a"]);
  });

  it("keeps layout and positions per graph", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    workspace = updateActiveGraph(workspace, {
      layout: "circle",
      positions: { a: { x: 10, y: 20 } }
    });
    workspace = switchActiveGraph(workspace, "all-documents");

    expect(workspace.layout).toBe("cose");
    expect(workspace.positions).toEqual({});
    workspace = switchActiveGraph(workspace, "case-alpha");
    expect(workspace.layout).toBe("circle");
    expect(workspace.positions).toEqual({ a: { x: 10, y: 20 } });
  });

  it("renames and deletes active graphs without deleting corpus documents", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    workspace = renameActiveGraph(workspace, "Renamed case");
    expect(getActiveGraph(workspace).name).toBe("Renamed case");

    workspace = deleteActiveGraph(workspace);
    expect(getActiveGraph(workspace).id).toBe("all-documents");
    expect(() => deleteActiveGraph(workspace)).toThrow("last graph");
  });

  it("keeps the membership key stable across viewport-only updates", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    workspace = addDocumentsToActiveGraph(workspace, ["b", "a"]);
    const membership = activeGraphMembershipKey(workspace);

    workspace = updateActiveGraph(workspace, {
      viewport: { pan: { x: 120, y: -40 }, zoom: 1.5 },
      selectedIds: ["a"]
    });

    expect(activeGraphMembershipKey(workspace)).toBe(membership);
    expect(membership).toBe('["a","b"]');
    expect(activeGraphMembershipKey(switchActiveGraph(workspace, "all-documents"))).toBe("*");
  });

  it("filters the corpus by active graph membership", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    workspace = addDocumentsToActiveGraph(workspace, ["a", "r"]);
    const documents = [{ _id: "a" }, { _id: "b" }, { _id: "r" }];

    expect(documentsForActiveGraph(workspace, documents)).toEqual([{ _id: "a" }, { _id: "r" }]);
    expect(
      documentsForActiveGraph(switchActiveGraph(workspace, "all-documents"), documents)
    ).toEqual(documents);
  });

  it("removes membership without touching documents", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    workspace = addDocumentsToActiveGraph(workspace, ["a", "b"], {
      positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } },
      selectedIds: ["a", "b"]
    });
    workspace = removeDocumentsFromActiveGraph(workspace, ["a"]);

    expect(getActiveGraph(workspace)).toMatchObject({
      documentIds: ["b"],
      positions: { b: { x: 2, y: 2 } },
      selectedIds: ["b"]
    });
    expect(() =>
      removeDocumentsFromActiveGraph(switchActiveGraph(workspace, "all-documents"), ["b"])
    ).toThrow("All documents");
  });
  it("clears a custom graph without deleting the graph", () => {
    let workspace = createGraph({}, "Case Alpha", { id: "case-alpha" });
    workspace = addDocumentsToActiveGraph(workspace, ["a", "b"], {
      positions: { a: { x: 1, y: 2 } },
      selectedIds: ["a"]
    });
    workspace = clearActiveGraph(workspace);

    expect(getActiveGraph(workspace)).toMatchObject({
      id: "case-alpha",
      documentIds: [],
      positions: {},
      viewport: null,
      selectedIds: []
    });
  });

  it("clears the corpus view by opening a new empty graph", () => {
    const workspace = clearActiveGraph({}, { emptyGraphName: "Fresh graph" });
    expect(getActiveGraph(workspace)).toMatchObject({
      name: "Fresh graph",
      documentIds: []
    });
    expect(workspace.graphs.some((graph) => graph.id === "all-documents")).toBe(true);
  });
});
