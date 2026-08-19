import { createContext, useContext, useMemo } from "react";

const UiRuntimeContext = createContext(null);

export function UiRuntimeProvider({ adapter, children }) {
  const value = useMemo(() => {
    if (!adapter?.id) throw new TypeError("Quasar UI runtime adapter requires an id");
    return Object.freeze({
      id: adapter.id,
      label: adapter.label || adapter.id,
      workspaceLabel: adapter.workspaceLabel || "StarIntel workspace",
      embedded: Boolean(adapter.embedded),
      standalone: Boolean(adapter.standalone),
      pwa: adapter.pwa !== false,
      capabilities: Object.freeze({ ...(adapter.capabilities || {}) }),
      health: adapter.health || (() => []),
      routePolicy: adapter.routePolicy || (() => true)
    });
  }, [adapter]);

  return <UiRuntimeContext.Provider value={value}>{children}</UiRuntimeContext.Provider>;
}

export function useUiRuntime() {
  const runtime = useContext(UiRuntimeContext);
  if (!runtime) throw new Error("useUiRuntime must be used inside UiRuntimeProvider");
  return runtime;
}
