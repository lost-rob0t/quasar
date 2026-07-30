import { describe, expect, it } from "vitest";
import {
  commitGraphTransaction,
  createGraphDocument,
  createGraphHistoryState,
  createGraphNode,
  redoGraphTransaction,
  undoGraphTransaction,
  type CanonicalGraphDocument,
  type GraphHistoryResult
} from "../../../src/core";
import { FIXTURE_TIMESTAMP } from "../../../src/testing/graph-fixtures";

const SECOND_TIMESTAMP = "2026-01-02T00:00:00.000Z";
const THIRD_TIMESTAMP = "2026-01-03T00:00:00.000Z";

function graphFixture(): CanonicalGraphDocument {
  return createGraphDocument({
    id: "graph:history",
    name: "History graph",
    timestamp: FIXTURE_TIMESTAMP,
    nodes: [
      createGraphNode({
        id: "person:ada",
        type: "person",
        label: "Ada Lovelace",
        properties: { full_name: "Ada Lovelace" },
        position: { x: 0, y: 0 },
        createdAt: FIXTURE_TIMESTAMP
      }),
      createGraphNode({
        id: "org:analytical-society",
        type: "org",
        label: "Analytical Society",
        properties: { name: "Analytical Society" },
        position: { x: 200, y: 0 },
        createdAt: FIXTURE_TIMESTAMP
      })
    ],
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    layout: "preset",
    selectedIds: ["person:ada"]
  });
}

function expectSuccess(result: GraphHistoryResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("; "));
  return result;
}

function expectRejection(result: GraphHistoryResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected history rejection");
  return result;
}

describe("graph transaction history", () => {
  it("advances the revision exactly once for an accepted transaction", () => {
    const state = createGraphHistoryState(graphFixture());
    const result = expectSuccess(
      commitGraphTransaction(
        state,
        {
          type: "add-node",
          timestamp: SECOND_TIMESTAMP,
          node: createGraphNode({
            id: "concept:mathematics",
            type: "concept",
            label: "Mathematics",
            properties: { name: "Mathematics" },
            createdAt: SECOND_TIMESTAMP
          })
        },
        {
          expectedRevision: 0,
          transactionId: "transaction:add-mathematics",
          label: "Add mathematics",
          timestamp: SECOND_TIMESTAMP
        }
      )
    );

    expect(state.revision).toBe(0);
    expect(state.graph.nodes).toHaveLength(2);
    expect(result.state.revision).toBe(1);
    expect(result.state.graph.nodes).toHaveLength(3);
    expect(result.state.undoStack).toHaveLength(1);
    expect(result.state.redoStack).toEqual([]);
    expect(result.transaction).toMatchObject({
      id: "transaction:add-mathematics",
      label: "Add mathematics",
      baseRevision: 0,
      committedRevision: 1,
      timestamp: SECOND_TIMESTAMP
    });
  });

  it("groups a multi-command batch into one revision and undo unit", () => {
    const state = createGraphHistoryState(graphFixture());
    const committed = expectSuccess(
      commitGraphTransaction(
        state,
        [
          {
            type: "add-node",
            timestamp: SECOND_TIMESTAMP,
            node: createGraphNode({
              id: "concept:engine",
              type: "concept",
              label: "Analytical engine",
              properties: { name: "Analytical engine" },
              createdAt: SECOND_TIMESTAMP
            })
          },
          {
            type: "move-nodes",
            timestamp: SECOND_TIMESTAMP,
            positions: {
              "person:ada": { x: 50, y: 75 },
              "concept:engine": { x: 400, y: 100 }
            }
          },
          {
            type: "set-view",
            timestamp: SECOND_TIMESTAMP,
            patch: {
              layout: "grid",
              selectedIds: ["concept:engine"],
              viewport: { zoom: 1.5, pan: { x: 20, y: -30 } }
            }
          }
        ],
        {
          expectedRevision: 0,
          label: "Import analytical engine",
          timestamp: SECOND_TIMESTAMP
        }
      )
    );

    expect(committed.state.revision).toBe(1);
    expect(committed.state.undoStack).toHaveLength(1);
    expect(committed.state.graph.nodes.map((node) => node.id)).toContain("concept:engine");
    expect(committed.state.graph.view).toMatchObject({
      layout: "grid",
      selectedIds: ["concept:engine"],
      viewport: { zoom: 1.5, pan: { x: 20, y: -30 } }
    });

    const undone = expectSuccess(undoGraphTransaction(committed.state, { expectedRevision: 1 }));

    expect(undone.state.revision).toBe(2);
    expect(undone.state.undoStack).toEqual([]);
    expect(undone.state.redoStack).toHaveLength(1);
    expect(undone.state.graph).toEqual(state.graph);
    expect(undone.state.graph.nodes.map((node) => node.id)).not.toContain("concept:engine");
    expect(undone.state.graph.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(undone.state.graph.view).toEqual(state.graph.view);
  });

  it("redoes a transaction and advances revision without rewriting its commit revision", () => {
    const state = createGraphHistoryState(graphFixture());
    const committed = expectSuccess(
      commitGraphTransaction(
        state,
        {
          type: "update-node",
          id: "person:ada",
          timestamp: SECOND_TIMESTAMP,
          patch: {
            label: "Augusta Ada King",
            properties: { full_name: "Augusta Ada King" }
          }
        },
        { expectedRevision: 0, timestamp: SECOND_TIMESTAMP }
      )
    );
    const undone = expectSuccess(undoGraphTransaction(committed.state, { expectedRevision: 1 }));
    const redone = expectSuccess(redoGraphTransaction(undone.state, { expectedRevision: 2 }));

    expect(redone.state.revision).toBe(3);
    expect(redone.state.graph).toEqual(committed.state.graph);
    expect(redone.state.undoStack).toHaveLength(1);
    expect(redone.state.redoStack).toEqual([]);
    expect(redone.transaction.committedRevision).toBe(1);
  });

  it("rejects stale expected revisions for commit, undo, and redo", () => {
    const state = createGraphHistoryState(graphFixture(), { revision: 5 });
    const staleCommit = expectRejection(
      commitGraphTransaction(
        state,
        {
          type: "set-viewport",
          viewport: null
        },
        { expectedRevision: 4 }
      )
    );
    const staleUndo = expectRejection(undoGraphTransaction(state, { expectedRevision: 4 }));
    const staleRedo = expectRejection(redoGraphTransaction(state, { expectedRevision: 6 }));

    for (const rejection of [staleCommit, staleUndo, staleRedo]) {
      expect(rejection.errors[0]).toMatchObject({
        code: "stale-revision",
        path: "expectedRevision"
      });
      expect(rejection.state).toBe(state);
      expect(rejection.state.revision).toBe(5);
    }
  });

  it("does not advance revision or add history when a command fails", () => {
    const state = createGraphHistoryState(graphFixture());
    const result = expectRejection(
      commitGraphTransaction(
        state,
        {
          type: "remove-node",
          id: "person:missing"
        },
        { expectedRevision: 0 }
      )
    );

    expect(result.errors[0]).toMatchObject({ code: "command-rejected" });
    expect(result.errors[0].commandErrors?.[0]).toMatchObject({ code: "not-found" });
    expect(result.state).toBe(state);
    expect(state.revision).toBe(0);
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
  });

  it("clears the redo branch after a new edit", () => {
    const state = createGraphHistoryState(graphFixture());
    const first = expectSuccess(
      commitGraphTransaction(
        state,
        {
          type: "move-nodes",
          timestamp: SECOND_TIMESTAMP,
          positions: { "person:ada": { x: 25, y: 25 } }
        },
        { timestamp: SECOND_TIMESTAMP }
      )
    );
    const undone = expectSuccess(undoGraphTransaction(first.state));
    expect(undone.state.redoStack).toHaveLength(1);

    const replacement = expectSuccess(
      commitGraphTransaction(
        undone.state,
        {
          type: "set-view",
          timestamp: THIRD_TIMESTAMP,
          patch: { layout: "circle" }
        },
        { timestamp: THIRD_TIMESTAMP }
      )
    );

    expect(replacement.state.revision).toBe(3);
    expect(replacement.state.redoStack).toEqual([]);
    expect(replacement.state.undoStack).toHaveLength(1);
    expect(replacement.state.graph.view.layout).toBe("circle");
  });

  it("bounds undo and redo stacks", () => {
    let state = createGraphHistoryState(graphFixture(), { limit: 2 });
    for (const [index, x] of [10, 20, 30].entries()) {
      state = expectSuccess(
        commitGraphTransaction(
          state,
          {
            type: "move-nodes",
            timestamp: SECOND_TIMESTAMP,
            positions: { "person:ada": { x, y: index } }
          },
          { transactionId: `transaction:move-${index}` }
        )
      ).state;
    }

    expect(state.revision).toBe(3);
    expect(state.undoStack.map((transaction) => transaction.id)).toEqual([
      "transaction:move-1",
      "transaction:move-2"
    ]);

    state = expectSuccess(undoGraphTransaction(state)).state;
    state = expectSuccess(undoGraphTransaction(state)).state;
    const empty = expectRejection(undoGraphTransaction(state));

    expect(state.redoStack).toHaveLength(2);
    expect(empty.errors[0]).toMatchObject({
      code: "history-empty",
      path: "undoStack"
    });
  });

  it("supports a zero history limit while still advancing revisions", () => {
    const state = createGraphHistoryState(graphFixture(), { limit: 0 });
    const committed = expectSuccess(
      commitGraphTransaction(state, {
        type: "set-viewport",
        viewport: { zoom: 2, pan: { x: 5, y: 5 } }
      })
    );

    expect(committed.state.revision).toBe(1);
    expect(committed.state.undoStack).toEqual([]);
    expect(committed.state.redoStack).toEqual([]);
    expect(undoGraphTransaction(committed.state)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "history-empty" })]
    });
  });

  it("rejects empty transactions", () => {
    const state = createGraphHistoryState(graphFixture());
    const result = expectRejection(commitGraphTransaction(state, [], { expectedRevision: 0 }));

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "empty-transaction",
        path: "commands"
      })
    ]);
    expect(result.state).toBe(state);
  });

  it("stores independent before and after snapshots", () => {
    const state = createGraphHistoryState(graphFixture());
    const committed = expectSuccess(
      commitGraphTransaction(state, {
        type: "move-nodes",
        positions: { "person:ada": { x: 100, y: 100 } }
      })
    );

    committed.state.graph.nodes[0].position = { x: 999, y: 999 };

    expect(committed.transaction.before.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(committed.transaction.after.nodes[0].position).toEqual({ x: 100, y: 100 });
    expect(state.graph.nodes[0].position).toEqual({ x: 0, y: 0 });
  });
});
