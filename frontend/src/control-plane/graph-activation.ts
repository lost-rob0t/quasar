import type { ControlPlaneClient } from "./client";
import { withWorkspaceScope } from "./workspace-scope";

/** Selecting a graph must not replace its membership or presentation metadata. */
export function activateGraph(
  client: Pick<ControlPlaneClient, "transaction" | "onConnectionStateChange">,
  id: string,
  pendingEdits: Promise<unknown>
) {
  return withWorkspaceScope(client, async (check) => {
    await pendingEdits;
    check();
    return client.transaction([{ type: "graph.activate", payload: { id } }]);
  });
}
