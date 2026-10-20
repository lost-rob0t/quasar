import { expect, it, vi } from "vitest";
import { activateGraph } from "./graph-activation";
it("waits for pending edits and activates without replacing graph metadata", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = vi.fn(async () => ({ revision: 3 }));
  const client = { transaction, onConnectionStateChange: () => () => {} };
  const result = activateGraph(client as Parameters<typeof activateGraph>[0], "saved", pending);
  expect(transaction).not.toHaveBeenCalled();
  release();
  await result;
  expect(transaction).toHaveBeenCalledExactlyOnceWith([
    { type: "graph.activate", payload: { id: "saved" } }
  ]);
});
it("does not activate if pending edits failed", async () => {
  const transaction = vi.fn();
  const client = { transaction, onConnectionStateChange: () => () => {} };
  await expect(
    activateGraph(
      client as Parameters<typeof activateGraph>[0],
      "saved",
      Promise.reject(new Error("edit failed"))
    )
  ).rejects.toThrow("edit failed");
  expect(transaction).not.toHaveBeenCalled();
});
