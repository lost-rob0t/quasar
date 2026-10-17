import { useEffect, useRef, useState } from "react";
import { getControlPlane } from "./client";
import { readDocumentListPage, type CanonicalPage, type DocumentScope } from "./document-list";

export function useDocumentList(scope: DocumentScope, limit: number) {
  const scopeKey = JSON.stringify(scope);
  const [page, setPage] = useState<CanonicalPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const actions = useRef({ next: () => {}, refresh: () => {} });
  const transportBusy = useRef(false);
  const queued = useRef<(() => void) | null>(null);
  useEffect(() => {
    const client = getControlPlane();
    if (!client) return;
    let active = true,
      connected = false,
      generation = 0;
    let current: CanonicalPage | null = null;
    const load = async (next = false) => {
      if (!active || !connected) return;
      if (transportBusy.current) {
        if (!next)
          queued.current = () => {
            void load();
          };
        return;
      }
      if (next && (!current || current.complete)) return;
      const started = generation;
      const previous = current;
      transportBusy.current = true;
      setLoading(true);
      setError(null);
      try {
        const revision =
          next && previous
            ? previous.revision
            : (await client.send<{ revision: number }>("workspace.bootstrap", {})).revision;
        if (!active || !connected || started !== generation) return;
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw new Error("Invalid document revision.");
        const result = await readDocumentListPage(
          client,
          JSON.parse(scopeKey),
          revision,
          next && previous ? previous.cursor : null,
          limit,
          () => {
            if (!active || !connected || generation !== started)
              throw new Error("Document query cancelled.");
          }
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
        transportBusy.current = false;
        if (active && started === generation) setLoading(false);
        const pending = queued.current;
        queued.current = null;
        pending?.();
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
  }, [scopeKey, limit]);
  return {
    page,
    error,
    loading,
    next: () => actions.current.next(),
    refresh: () => actions.current.refresh()
  };
}
