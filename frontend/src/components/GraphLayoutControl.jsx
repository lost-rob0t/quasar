import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Grid2X2 } from "lucide-react";
import { useLocation } from "react-router-dom";
import { MALTEGO_LAYOUTS, normalizeMaltegoLayout } from "../graph/maltego-layouts";
import { useQuasar } from "../store";
import "./graph-layout-control.css";

const LEGACY_CONTEXT_LAYOUTS = new Set(["cose", "breadthfirst", "circle", "concentric", "grid"]);

function findToolbarHost() {
  const toolbar = document.querySelector(".graph-toolbar");
  const legacySelect = toolbar?.querySelector('select[aria-label="Graph layout"]');
  if (!toolbar || !legacySelect) return null;

  const existing = toolbar.querySelector("[data-maltego-layout-host]");
  if (existing) return existing;

  const host = document.createElement("span");
  host.className = "maltego-layout-control";
  host.dataset.maltegoLayoutHost = "true";
  legacySelect.before(host);
  return host;
}

function findContextHost() {
  const menus = document.querySelectorAll(".graph-context-menu");

  for (const menu of menus) {
    const buttons = [...menu.querySelectorAll(':scope > button[role="menuitem"]')];
    const legacyButtons = buttons.filter((button) =>
      LEGACY_CONTEXT_LAYOUTS.has(button.textContent.trim())
    );
    if (legacyButtons.length !== LEGACY_CONTEXT_LAYOUTS.size) continue;

    const existing = menu.querySelector("[data-maltego-context-layout-host]");
    if (existing) return existing;

    const host = document.createElement("span");
    host.className = "maltego-context-layout-host";
    host.dataset.maltegoContextLayoutHost = "true";
    legacyButtons[0].before(host);
    legacyButtons.forEach((button) => {
      button.dataset.maltegoLegacyLayout = "true";
    });
    return host;
  }

  return null;
}

function dispatchLayout(layout) {
  window.dispatchEvent(
    new CustomEvent("quasar:agent-graph-command", {
      detail: { op: "apply_layout", layout }
    })
  );
}

export default function GraphLayoutControl() {
  const location = useLocation();
  const { workspace } = useQuasar();
  const [toolbarHost, setToolbarHost] = useState(null);
  const [contextHost, setContextHost] = useState(null);
  const onGraph = location.pathname === "/graph";

  useEffect(() => {
    if (!onGraph) {
      setToolbarHost(null);
      setContextHost(null);
      return undefined;
    }

    let active = true;
    const attach = () => {
      if (!active) return;
      setToolbarHost(findToolbarHost());
      setContextHost(findContextHost());
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      active = false;
      observer.disconnect();
    };
  }, [onGraph]);

  if (!onGraph) return null;

  const layout = normalizeMaltegoLayout(workspace?.layout);
  const closeContextMenu = () => {
    document
      .querySelector(".graph-stage")
      ?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  };

  return (
    <>
      {toolbarHost &&
        createPortal(
          <select
            className="maltego-layout-select"
            aria-label="Maltego graph layout"
            title="Maltego graph layout"
            value={layout}
            onChange={(event) => dispatchLayout(event.target.value)}
          >
            {MALTEGO_LAYOUTS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>,
          toolbarHost
        )}
      {contextHost &&
        createPortal(
          MALTEGO_LAYOUTS.map((candidate) => (
            <button
              role="menuitem"
              type="button"
              key={candidate.id}
              onClick={() => {
                dispatchLayout(candidate.id);
                closeContextMenu();
              }}
            >
              <Grid2X2 size={15} /> {candidate.label}
            </button>
          )),
          contextHost
        )}
    </>
  );
}
