import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "../App.jsx";
import AutoDigHostBridge, {
  isAutoDigEmbedded
} from "../integrations/auto-dig/AutoDigHostBridge.jsx";
import ActorConfigurationBridge from "../components/ActorConfigurationBridge.jsx";
import GraphContextRadialBridge from "../components/GraphContextRadialBridge.jsx";
import GraphObjectTypePickerBridge from "../components/GraphObjectTypePickerBridge.jsx";
import MelissaActorBridge from "../components/MelissaActorBridge.jsx";
import MobileGraphToolTray from "../components/MobileGraphToolTray.jsx";
import OperatorUiEnhancer from "../components/OperatorUiEnhancer.jsx";
import PwaInstallBridge from "../components/PwaInstallBridge.jsx";
import ReviewActorBridge from "../components/ReviewActorBridge.jsx";
import RunAllTransformationsBridge from "../components/RunAllTransformationsBridge.jsx";
import { QuasarProvider } from "../store.jsx";
import { registerServiceWorker } from "../lib/service-worker-registration.js";
import { initializeTheme } from "../lib/themes.js";
import { routerBasename } from "./base-path";
import { redactDiagnostic } from "./runtime-diagnostics";
import { initializeControlPlane } from "../control-plane";
import "../styles.css";
import "../dashboard.css";
import "../dashboard-theme.css";
import "../mobile.css";
import "../mobile-editor.css";
import "../gesture-menu.css";
import "../operator-ui.css";
import "../dataset-menu.css";
import "../graph-fullscreen.css";
import "../mobile-graph-tools.css";
import "../mobile-graph-empty-state.css";
import "../graph-editors.css";
import "../graph-editors-extra.css";
import "../graph-workspace-shell.css";
import "../graph-full-viewport-modern.css";
import "../melissa-actors.css";
import "../actor-configuration.css";

function runtimeContext(): string {
  return `route=${window.location.pathname} online=${navigator.onLine}`;
}

function logRuntimeFailure(source: string, error: unknown, details = ""): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(
    redactDiagnostic(
      `[quasar-runtime:${source}] ${normalized.name}: ${normalized.message}\n` +
        `${normalized.stack || "No JavaScript stack available"}\n` +
        `${runtimeContext()}${details ? `\n${details}` : ""}`
    )
  );
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

if (import.meta.env.DEV) {
  window.addEventListener("error", (event) => {
    logRuntimeFailure("window", event.error || event.message, `${event.filename}:${event.lineno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logRuntimeFailure("promise", event.reason);
  });
}

initializeTheme();
initializeControlPlane();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Quasar root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <RuntimeErrorBoundary>
      <BrowserRouter basename={routerBasename(import.meta.env.BASE_URL)}>
        <QuasarProvider>
          <App />
          <AutoDigHostBridge />
          <OperatorUiEnhancer />
          <PwaInstallBridge />
          <MelissaActorBridge />
          <ReviewActorBridge />
          <ActorConfigurationBridge />
          <RunAllTransformationsBridge />
          <MobileGraphToolTray />
          <GraphContextRadialBridge />
          <GraphObjectTypePickerBridge />
        </QuasarProvider>
      </BrowserRouter>
    </RuntimeErrorBoundary>
  </StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD && !isAutoDigEmbedded()) {
  window.addEventListener("load", () => registerServiceWorker().catch(() => {}));
}
