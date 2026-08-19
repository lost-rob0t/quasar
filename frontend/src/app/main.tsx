import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "../App.jsx";
import AutoDigHostBridge, {
  isAutoDigEmbedded
} from "../integrations/auto-dig/AutoDigHostBridge.jsx";
import GraphContextRadialBridge from "../components/GraphContextRadialBridge.jsx";
import GraphObjectTypePickerBridge from "../components/GraphObjectTypePickerBridge.jsx";
import MelissaActorMigrationBridge from "../components/MelissaActorMigrationBridge.jsx";
import MobileGraphToolTray from "../components/MobileGraphToolTray.jsx";
import PwaInstallBridge from "../components/PwaInstallBridge.jsx";
import ReviewActorBridge from "../components/ReviewActorBridge.jsx";
import RunAllTransformationsBridge from "../components/RunAllTransformationsBridge.jsx";
import { QuasarProvider } from "../store.jsx";
import { registerServiceWorker } from "../lib/service-worker-registration.js";
import { initializeTheme } from "../lib/themes.js";
import { routerBasename } from "./base-path";
import { recordRuntimeDiagnostic, redactDiagnostic } from "./runtime-diagnostics";
import { initializeControlPlane } from "../control-plane";
import { autoDigAdapter, controlPlaneAdapter } from "../ui-core/adapters";
import { UiRuntimeProvider } from "../ui-core/runtime";
import "../styles.css";
import "../document-search.css";
import "../dashboard.css";
import "../dashboard-theme.css";
import "../mobile.css";
import "../mobile-editor.css";
import "../gesture-menu.css";
import "../operator-ui.css";
import "../dataset-menu.css";
import "../mobile-graph-tools.css";
import "../mobile-graph-empty-state.css";
import "../graph-editors.css";
import "../graph-editors-extra.css";
import "../settings-runtime-log.css";
import "../agent-tab-icons.css";
import "../kinpaku-shell.css";
import "../ui-core/ui-core.css";

function runtimeContext(): string {
  return `route=${window.location.pathname} online=${navigator.onLine}`;
}

function logRuntimeFailure(source: string, error: unknown, details = ""): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const diagnostic = redactDiagnostic(
    `${normalized.name}: ${normalized.message}\n${normalized.stack || "No JavaScript stack available"}\n` +
      `${runtimeContext()}${details ? `\n${details}` : ""}`
  );
  recordRuntimeDiagnostic({
    level: "error",
    source,
    message: `${normalized.name}: ${normalized.message}`,
    details: diagnostic
  });
  console.error(`[quasar-runtime:${source}] ${diagnostic}`);
}

class RuntimeErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logRuntimeFailure("react", error, `componentStack=${info.componentStack || "unavailable"}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page-card" role="alert">
        <h1>Quasar encountered a runtime error</h1>
        <p>{this.state.error.message}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Reload application
        </button>
      </main>
    );
  }
}

window.addEventListener("error", (event) => {
  logRuntimeFailure("window", event.error || event.message, `${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  logRuntimeFailure("promise", event.reason);
});
window.addEventListener("quasar:control-plane-error", (event) => {
  const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
  const message = String(detail.message || "Common Lisp control-plane error.");
  const fields = { ...detail };
  delete fields.message;
  recordRuntimeDiagnostic({
    level: "error",
    source: "control-plane",
    message,
    details: JSON.stringify(fields)
  });
  console.error(`[quasar-control:error] ${message}`, fields);
});

if (import.meta.env.DEV) {
  try {
    const requested = new URLSearchParams(window.location.search).get("debug");
    if (requested !== "0") window.localStorage.setItem("quasar-debug", "1");
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
}

initializeTheme();
const controlPlane = initializeControlPlane();
let lastControlPlanePhase = "connecting";
controlPlane.onConnectionStateChange((state) => {
  if (state.connected && state.synchronized) {
    if (lastControlPlanePhase !== "connected") {
      recordRuntimeDiagnostic({
        level: "info",
        source: "control-plane",
        message: "WebSocket connected and workspace synchronized."
      });
    }
    lastControlPlanePhase = "connected";
    return;
  }

  if (
    (state.phase === "disconnected" || state.phase === "reconnecting") &&
    state.phase !== lastControlPlanePhase
  ) {
    recordRuntimeDiagnostic({
      level: "warning",
      source: "control-plane",
      message: "WebSocket is not connected.",
      details: `phase=${state.phase} attempts=${state.attempts}`
    });
  }
  lastControlPlanePhase = state.phase;
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Quasar root element was not found");

const runtimeAdapter = isAutoDigEmbedded() ? autoDigAdapter : controlPlaneAdapter;

createRoot(rootElement).render(
  <StrictMode>
    <RuntimeErrorBoundary>
      <BrowserRouter basename={routerBasename(import.meta.env.BASE_URL)}>
        <UiRuntimeProvider adapter={runtimeAdapter}>
          <QuasarProvider>
            <App />
            <AutoDigHostBridge />
            <PwaInstallBridge />
            <MelissaActorMigrationBridge />
            <ReviewActorBridge />
            <RunAllTransformationsBridge />
            <MobileGraphToolTray />
            <GraphContextRadialBridge />
            <GraphObjectTypePickerBridge />
          </QuasarProvider>
        </UiRuntimeProvider>
      </BrowserRouter>
    </RuntimeErrorBoundary>
  </StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD && !isAutoDigEmbedded()) {
  window.addEventListener("load", () => registerServiceWorker().catch(() => {}));
}
