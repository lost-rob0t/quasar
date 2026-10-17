import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

/** Long-running consumers must recheck this scope immediately before applying output. */
export async function withWorkspaceScope<T>(
  client: Pick<ControlPlaneClient, "onConnectionStateChange">,
  run: (check: () => void, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let workspace: string | undefined;
  let initialized = false;
  const unsubscribe = client.onConnectionStateChange((state) => {
    if (!state.synchronized || (initialized && workspace !== state.workspaceId)) controller.abort();
    workspace = state.workspaceId;
    initialized = true;
  });
  const check = () => {
    if (controller.signal.aborted)
      throw new ControlPlaneError(
        "query.cancelled",
        "Workspace changed while the operation was running."
      );
  };
  try {
    check();
    const result = await run(check, controller.signal);
    check();
    return result;
  } finally {
    unsubscribe();
  }
}
