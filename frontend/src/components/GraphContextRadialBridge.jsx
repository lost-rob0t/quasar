import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Building2,
  CalendarDays,
  CircleDot,
  Database,
  FileText,
  Grid2X2,
  Lightbulb,
  MapPin,
  Network,
  Plus,
  UserRound,
  X
} from "lucide-react";
import { createPortal } from "react-dom";

const QUICK_TYPES = [
  { label: "person", Icon: UserRound },
  { label: "organization", Icon: Building2 },
  { label: "event", Icon: CalendarDays },
  { label: "location", Icon: MapPin },
  { label: "entity", Icon: CircleDot },
  { label: "document", Icon: FileText },
  { label: "source", Icon: BookOpen },
  { label: "concept", Icon: Lightbulb },
  { label: "research node", Icon: Network }
];

const CATEGORY_MATCHERS = {
  create: (label) => label.startsWith("Create ") || label.startsWith("Other object type"),
  graph: (label) =>
    /^(Fit graph|Focus selection|Clear filters|Clear graph|Add from corpus|New graph)$/.test(label),
  layout: (label) => label.startsWith("Layout:"),
  ingest: (label) =>
    /^(Import documents|Start queue listener|Stop queue listener|Connection settings)$/.test(label)
};

function actionLabel(element) {
  return element?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function originalActions(menu) {
  return [
    ...menu.querySelectorAll(":scope > button[role='menuitem'], :scope > a[role='menuitem']")
  ].filter((element) => !element.dataset.radialBridge);
}

function invokeAction(menu, predicate) {
  const action = originalActions(menu).find((element) => predicate(actionLabel(element)));
  action?.click();
}

export default function GraphContextRadialBridge() {
  const [menu, setMenu] = useState(null);
  const [category, setCategory] = useState("");
  const [, setVersion] = useState(0);

  useEffect(() => {
    const sync = () => {
      const next = document.querySelector(".graph-context-menu.canvas-actions");
      setMenu((current) => (current === next ? current : next));
      setVersion((current) => current + 1);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => setCategory(""), [menu]);

  const categoryActions = useMemo(() => {
    if (!menu || !category) return [];
    const matcher = CATEGORY_MATCHERS[category];
    return originalActions(menu)
      .map((element) => ({ element, label: actionLabel(element) }))
      .filter(({ label }) => matcher(label));
  }, [category, menu]);

  if (!menu) return null;

  return createPortal(
    <>
      <div
        className="graph-context-palette"
        aria-label="Create node type"
        data-radial-bridge="true"
      >
        {QUICK_TYPES.map(({ label, Icon }) => (
          <button
            key={label}
            type="button"
            aria-label={`Create ${label} here`}
            title={label}
            onClick={() => invokeAction(menu, (action) => action === `Create ${label}`)}
          >
            <Icon size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
      <button
        data-radial-bridge="true"
        data-radial-slot="create"
        className="radial-category"
        role="menuitem"
        type="button"
        onClick={() => setCategory("create")}
      >
        <Plus size={15} /> Create node
      </button>
      <button
        data-radial-bridge="true"
        data-radial-slot="graph"
        className="radial-category"
        role="menuitem"
        type="button"
        onClick={() => setCategory("graph")}
      >
        <Network size={15} /> Graph
      </button>
      <button
        data-radial-bridge="true"
        data-radial-slot="layout"
        className="radial-category"
        role="menuitem"
        type="button"
        onClick={() => setCategory("layout")}
      >
        <Grid2X2 size={15} /> Layout
      </button>
      <button
        data-radial-bridge="true"
        data-radial-slot="ingest"
        className="radial-category"
        role="menuitem"
        type="button"
        onClick={() => setCategory("ingest")}
      >
        <Database size={15} /> Ingest
      </button>
      {category && (
        <div
          className="radial-action-submenu"
          role="menu"
          aria-label={`${category} actions`}
          data-radial-bridge="true"
        >
          <header>
            <strong>{category}</strong>
            <button type="button" aria-label="Close actions" onClick={() => setCategory("")}>
              <X size={14} />
            </button>
          </header>
          {categoryActions.map(({ element, label }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              disabled={element.disabled}
              onClick={() => element.click()}
            >
              {label}
            </button>
          ))}
          {!categoryActions.length && <small>No actions available.</small>}
        </div>
      )}
    </>,
    menu
  );
}
