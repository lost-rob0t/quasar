import { useEffect, useRef, useState } from "react";
import { getControlPlane } from "./client";
import { readDatasetPage, type DatasetPage } from "./dataset-catalog";

export function useDatasetCatalog() {
  const [page, setPage] = useState<DatasetPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const actions = useRef({ next: () => {}, refresh: () => {} });
  useEffect(() => {
    const client = getControlPlane();
    if (!client) return;
    let active = true,
      connected = false,
      running = false,
      dirty = false,
      generation = 0;
    let current: DatasetPage | null = null;
    const load = async (next = false) => {
      if (!active || !connected) return;
      if (running) {
        if (!next) dirty = true;
        return;
      }
      if (next && (!current || current.complete)) return;
      const started = generation;
      const previous = current;
      running = true;
      setLoading(true);
      setError(null);
      try {
        const revision =
          next && previous
            ? previous.revision
            : (await client.send<{ revision: number }>("workspace.bootstrap", {})).revision;
        if (!active || !connected || started !== generation) return;
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw new Error("Invalid catalog revision.");
        const result = await readDatasetPage(
          client.send,
          revision,
          next && previous ? previous.cursor : null
        );
        if (active && connected && started === generation) {
          current = result;
          setPage(result);
        }
      } catch (failure) {
        if (active && connected && started === generation) {
          current = null;
          setPage(null);
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      } finally {
        running = false;
        if (active && started === generation) setLoading(false);
        if (dirty) {
          dirty = false;
          void load();
        }
      }
    };
    const reset = () => {
      generation += 1;
      current = null;
      setPage(null);
      setError(null);
      setLoading(true);
      void load();
    };
    actions.current = {
      next: () => {
        void load(true);
      },
      refresh: reset
    };
    const connection = client.onConnectionStateChange((state) => {
      if (!state.synchronized) {
        connected = false;
        reset();
      } else if (!connected) {
        connected = true;
        reset();
      }
    });
    const events = client.subscribe(reset);
    return () => {
      active = false;
      generation += 1;
      connection();
      events();
    };
  }, []);
  return {
    page,
    error,
    loading,
    next: () => actions.current.next(),
    refresh: () => actions.current.refresh()
  };
}
