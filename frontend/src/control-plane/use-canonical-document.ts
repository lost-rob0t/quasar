import { useEffect, useState } from "react";
import { getControlPlane } from "./client";
import { readCanonicalDocument } from "./canonical-read";

type Result = {
  id: string | null;
  status: "loading" | "ready" | "error";
  document: Record<string, unknown> | null;
  error?: string;
};
/** One canonical selection; route cleanup discards late replies. Never infer absence from a cache. */
export function useCanonicalDocument(id: string | null, refreshOnEvents = true): Result {
  const [result, setResult] = useState<Result>({ id, status: "loading", document: null });
  useEffect(() => {
    if (!id) return;
    const client = getControlPlane();
    if (!client) return;
    let active = true,
      connected = false,
      running = false,
      dirty = false,
      loaded = false,
      selectedWorkspace: string | undefined,
      generation = 0;
    const controller = new AbortController();
    const refresh = () => {
      if (!active || !connected) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      const started = generation;
      void readCanonicalDocument(client, id, controller.signal)
        .then((document) => {
          if (active && connected && started === generation) {
            loaded = true;
            setResult({ id, status: "ready", document });
          }
        })
        .catch((error: unknown) => {
          if (active && connected && started === generation)
            setResult({
              id,
              status: "error",
              document: null,
              error: error instanceof Error ? error.message : String(error)
            });
        })
        .finally(() => {
          running = false;
          if (dirty) {
            dirty = false;
            refresh();
          }
        });
    };
    const connection = client.onConnectionStateChange((state) => {
      if (selectedWorkspace !== undefined && selectedWorkspace !== state.workspaceId)
        loaded = false;
      selectedWorkspace = state.workspaceId;
      if (!state.synchronized) {
        connected = false;
        generation += 1;
        if (refreshOnEvents || !loaded) setResult({ id, status: "loading", document: null });
      } else if (!connected) {
        connected = true;
        if (refreshOnEvents || !loaded) refresh();
      }
    });
    const events = refreshOnEvents
      ? client.subscribe(() => {
          generation += 1;
          refresh();
        })
      : () => {};
    return () => {
      active = false;
      controller.abort();
      connection();
      events();
    };
  }, [id, refreshOnEvents]);
  return result.id === id ? result : { id, status: "loading", document: null };
}
