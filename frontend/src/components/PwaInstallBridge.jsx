import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useQuasar } from "../store";

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

export default function PwaInstallBridge() {
  const location = useLocation();
  const { setNotice } = useQuasar();
  const graphRoute = location.pathname === "/graph";
  const [stage, setStage] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const captureInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const markInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  useEffect(() => {
    if (!graphRoute) {
      setStage(null);
      return undefined;
    }

    let frame = 0;
    const sync = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = document.querySelector(".graph-stage");
        setStage((current) => (current === next ? current : next));
      });
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [graphRoute]);

  if (!graphRoute || !stage || installed) return null;

  const install = async () => {
    if (!installPrompt) {
      setNotice({
        kind: "info",
        message:
          "The browser install prompt is not ready. Use the browser menu and choose Install Quasar or Add to Home Screen."
      });
      return;
    }

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice?.outcome === "accepted") setInstalled(true);
      setInstallPrompt(null);
    } catch (error) {
      setNotice({ kind: "error", message: error.message || "Quasar could not be installed." });
    }
  };

  return createPortal(
    <button
      type="button"
      className="graph-pwa-install"
      aria-label="Install Quasar"
      title={installPrompt ? "Install Quasar as an app" : "Install Quasar from the browser menu"}
      onClick={install}
    >
      <Download size={18} aria-hidden="true" />
      <span>Install app</span>
    </button>,
    stage
  );
}
