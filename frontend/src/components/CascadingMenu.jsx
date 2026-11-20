import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CornerLeftUp } from "lucide-react";

// Bounded cascade depth: operator asked for a 3-level right-click system
// (root -> path -> leaf); a hard cap keeps runaway trees impossible.
export const CASCADE_MAX_DEPTH = 3;

function itemChildren(item) {
  return typeof item.children === "function" ? item.children() : item.children;
}

function normalizeItems(items) {
  return (items || []).filter(Boolean);
}

/**
 * Cascading right-click menu: selecting down each path opens the next
 * panel (up to CASCADE_MAX_DEPTH levels). Items are
 * { label, Icon?, onSelect?, disabled?, title?, children?|childrenFn? }.
 * Keyboard: arrows move, Right/Enter enters or activates, Left/Escape backs out.
 */
export default function CascadingMenu({
  x,
  y,
  items,
  header,
  onClose,
  bounds,
  fixed = false,
  className = ""
}) {
  const rootItems = useMemo(() => normalizeItems(items), [items]);
  const [path, setPath] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (path.length) {
          setPath((current) => current.slice(0, -1));
          setActiveIndex((current) => Math.max(0, current - 1));
        } else {
          onClose();
        }
        return;
      }
      const levelItems =
        path.length === 0 ? rootItems : walkPath(rootItems, path)?.levelItems || [];
      if (!levelItems.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => Math.min(levelItems.length - 1, current + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => Math.max(0, current - 1));
      } else if (event.key === "ArrowRight" || event.key === "Enter") {
        const item = levelItems[activeIndex];
        if (!item) return;
        const children = itemChildren(item);
        if (event.key === "ArrowRight" && children?.length) {
          event.preventDefault();
          setPath((current) => [...current, activeIndex]);
          setActiveIndex(0);
        } else if (event.key === "Enter" && item.onSelect && !item.disabled) {
          event.preventDefault();
          item.onSelect();
        }
      } else if (event.key === "ArrowLeft" && path.length) {
        event.preventDefault();
        setPath((current) => current.slice(0, -1));
        setActiveIndex(0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rootItems, path, activeIndex, onClose]);

  useEffect(() => {
    const onOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) onClose();
    };
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("contextmenu", onOutside, true);
    return () => {
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("contextmenu", onOutside, true);
    };
  }, [onClose]);

  // Panels: root plus one panel per path step.
  const panels = useMemo(() => {
    const result = [{ items: rootItems, breadcrumb: header || "" }];
    let levelItems = rootItems;
    for (const index of path) {
      const item = levelItems[index];
      if (!item) break;
      const children = normalizeItems(itemChildren(item));
      result.push({
        items: children,
        breadcrumb: [...(result[result.length - 1].crumbs || []), item.label].slice(-2),
        crumbs: [...(result[result.length - 1].crumbs || []), item.label]
      });
      levelItems = children;
      if (result.length >= CASCADE_MAX_DEPTH) break;
    }
    return result;
  }, [rootItems, path, header]);

  const panelWidth = 232;
  // SSR-safe viewport bounds (the suite renders to static markup).
  const viewportWidth = bounds?.width ?? (typeof window === "undefined" ? 1280 : window.innerWidth);
  const viewportHeight =
    bounds?.height ?? (typeof window === "undefined" ? 800 : window.innerHeight);
  const style = {
    position: fixed ? "fixed" : "absolute",
    left: Math.max(8, Math.min(x, viewportWidth - panelWidth * panels.length - 16)),
    top: Math.max(8, Math.min(y, viewportHeight - 120))
  };

  const flattenedIndex = (panelIndex, itemIndex) =>
    panelIndex === panels.length - 1 ? itemIndex : -1;

  return (
    <div className={`cascading-menu ${className}`} ref={menuRef} style={style} role="menubar">
      {panels.map((panel, panelIndex) => (
        <div
          className="cascading-panel"
          key={panelIndex}
          role="menu"
          aria-label={panel.breadcrumb || "Actions"}
        >
          {panelIndex > 0 && (
            <button
              type="button"
              className="cascading-back"
              onClick={() => {
                setPath((current) => current.slice(0, -1));
                setActiveIndex(0);
              }}
            >
              <CornerLeftUp size={13} /> {panel.crumbs.slice(-1)[0]}
            </button>
          )}
          {panel.items.map((item, itemIndex) => {
            const children = normalizeItems(itemChildren(item) || []);
            const isActive =
              flattenedIndex(panelIndex, itemIndex) === activeIndex && path.length === panelIndex;
            const hasChildren = children.length > 0 && panelIndex + 1 < CASCADE_MAX_DEPTH;
            const Icon = item.Icon;
            return (
              <button
                type="button"
                key={item.label}
                role="menuitem"
                className={[
                  "cascading-item",
                  isActive ? "active" : "",
                  item.disabled ? "disabled" : "",
                  item.danger ? "danger" : ""
                ].join(" ")}
                disabled={item.disabled}
                title={item.title}
                aria-haspopup={hasChildren ? "menu" : undefined}
                onMouseEnter={() => {
                  if (panelIndex === path.length) setActiveIndex(itemIndex);
                }}
                onClick={() => {
                  if (item.disabled) return;
                  if (hasChildren) {
                    setPath((current) => [...current.slice(0, panelIndex), itemIndex]);
                    setActiveIndex(0);
                  } else if (item.onSelect) {
                    item.onSelect();
                  }
                }}
              >
                {Icon ? <Icon size={15} aria-hidden="true" /> : null}
                <span className="cascading-label">{item.label}</span>
                {hasChildren && <ChevronRight size={14} aria-hidden="true" />}
              </button>
            );
          })}
          {!panel.items.length && <span className="cascading-empty">Nothing available</span>}
        </div>
      ))}
    </div>
  );
}

function walkPath(rootItems, path) {
  let levelItems = rootItems;
  let item = null;
  for (const index of path) {
    item = levelItems[index];
    if (!item) return { levelItems: [] };
    const children = normalizeItems(itemChildren(item) || []);
    levelItems = children;
  }
  return { levelItems, item };
}
