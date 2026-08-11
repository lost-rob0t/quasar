const GESTURE_SCRATCH = "quasar-graph-gestures";
const DESKTOP_DROP_PADDING = 14;
const TOUCH_DROP_PADDING = 30;
const DRAG_THRESHOLD_SQUARED = 36;
const CONTEXT_TAP_SUPPRESS_MS = 250;

function distanceSquared(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

export function boxesOverlap(left, right, padding = 0) {
  return !(
    left.x2 + padding < right.x1 ||
    left.x1 - padding > right.x2 ||
    left.y2 + padding < right.y1 ||
    left.y1 - padding > right.y2
  );
}

export function selectionBoxFromPoints(start, end) {
  return {
    x1: Math.min(start.x, end.x),
    y1: Math.min(start.y, end.y),
    x2: Math.max(start.x, end.x),
    y2: Math.max(start.y, end.y)
  };
}

export function relationDropPadding(pointerType = "") {
  return pointerType === "touch" || pointerType === "pen"
    ? TOUCH_DROP_PADDING
    : DESKTOP_DROP_PADDING;
}

export function selectSingleNode(cy, node) {
  if (!cy || !node?.length) return false;

  const apply = () => {
    const otherNodes = cy.$("node:selected").not(node);
    if (otherNodes.length) otherNodes.unselect();
    if (!node.selected()) node.select();
  };

  if (typeof cy.batch === "function") cy.batch(apply);
  else apply();
  return true;
}

export function selectNodesInRenderedBox(cy, box) {
  if (!cy || !box) return [];

  const matches = [];
  cy.nodes().forEach((node) => {
    if (typeof node.visible === "function" && !node.visible()) return;
    const bounds = node.renderedBoundingBox({
      includeLabels: false,
      includeOverlays: false
    });
    if (boxesOverlap(bounds, box)) matches.push(node);
  });

  const apply = () => {
    const selected = cy.$("node:selected");
    if (selected.length) selected.unselect();
    for (const node of matches) {
      if (!node.selected()) node.select();
    }
  };

  if (typeof cy.batch === "function") cy.batch(apply);
  else apply();
  return matches.map((node) => node.id());
}

export function findRelationDropTarget(cy, sourceNode, padding = DESKTOP_DROP_PADDING) {
  if (!cy || !sourceNode?.length) return null;
  const sourceBox = sourceNode.renderedBoundingBox({
    includeLabels: false,
    includeOverlays: false
  });
  const sourcePosition = sourceNode.renderedPosition();
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  cy.nodes().forEach((candidate) => {
    if (candidate.id() === sourceNode.id() || candidate.data("unresolved") || !candidate.visible())
      return;

    const targetBox = candidate.renderedBoundingBox({
      includeLabels: false,
      includeOverlays: false
    });
    if (!boxesOverlap(sourceBox, targetBox, padding)) return;
    const distance = distanceSquared(sourcePosition, candidate.renderedPosition());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  });

  return best;
}

function pointerTypeFromEvent(event) {
  const originalEvent = event?.originalEvent;
  if (!originalEvent || !("pointerType" in originalEvent)) return "";
  return typeof originalEvent.pointerType === "string" ? originalEvent.pointerType : "";
}

function suppressEvent(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  event?.stopPropagation?.();
  event?.originalEvent?.preventDefault?.();
  event?.originalEvent?.stopImmediatePropagation?.();
  event?.originalEvent?.stopPropagation?.();
}

function createSelectionOverlay(container) {
  if (typeof document === "undefined") return null;
  const overlay = document.createElement("div");
  overlay.className = "graph-right-drag-selection";
  Object.assign(overlay.style, {
    position: "absolute",
    display: "none",
    pointerEvents: "none",
    zIndex: "40",
    border: "1px solid var(--accent, #f5c542)",
    background: "color-mix(in srgb, var(--accent, #f5c542) 18%, transparent)",
    boxSizing: "border-box"
  });
  container.append(overlay);
  return overlay;
}

function updateSelectionOverlay(overlay, box) {
  if (!overlay) return;
  overlay.style.display = "block";
  overlay.style.left = `${box.x1}px`;
  overlay.style.top = `${box.y1}px`;
  overlay.style.width = `${Math.max(1, box.x2 - box.x1)}px`;
  overlay.style.height = `${Math.max(1, box.y2 - box.y1)}px`;
}

function hideSelectionOverlay(overlay) {
  if (overlay) overlay.style.display = "none";
}

function installRightDragSelection(cy, state) {
  const container = cy.container?.();
  if (!container) return () => {};

  const overlay = createSelectionOverlay(container);
  state.selectionOverlay = overlay;

  cy.on("cxttapstart", (event) => {
    const pointerType = pointerTypeFromEvent(event);
    if (pointerType === "touch" || pointerType === "pen" || !event.renderedPosition) return;
    state.rightDrag = {
      start: { ...event.renderedPosition },
      current: { ...event.renderedPosition },
      moved: false
    };
  });

  cy.on("cxtdrag", (event) => {
    const drag = state.rightDrag;
    if (!drag || !event.renderedPosition) return;
    drag.current = { ...event.renderedPosition };
    if (!drag.moved) {
      drag.moved = distanceSquared(drag.start, drag.current) >= DRAG_THRESHOLD_SQUARED;
    }
    if (!drag.moved) return;
    updateSelectionOverlay(overlay, selectionBoxFromPoints(drag.start, drag.current));
    suppressEvent(event);
  });

  cy.on("cxttapend", (event) => {
    const drag = state.rightDrag;
    state.rightDrag = null;
    hideSelectionOverlay(overlay);
    if (!drag?.moved) return;

    const end = event.renderedPosition || drag.current;
    selectNodesInRenderedBox(cy, selectionBoxFromPoints(drag.start, end));
    state.suppressContextTapUntil = Date.now() + CONTEXT_TAP_SUPPRESS_MS;
    clearTimeout(state.suppressContextTapTimer);
    state.suppressContextTapTimer = setTimeout(() => {
      state.suppressContextTapUntil = 0;
      state.suppressContextTapTimer = null;
    }, CONTEXT_TAP_SUPPRESS_MS);
    suppressEvent(event);
  });

  cy.on("cxttap", (event) => {
    if (Date.now() < state.suppressContextTapUntil) {
      suppressEvent(event);
      return;
    }
    if (event.target?.isNode?.()) selectSingleNode(cy, event.target);
  });

  return () => {
    clearTimeout(state.suppressContextTapTimer);
    hideSelectionOverlay(overlay);
    overlay?.remove();
    state.selectionOverlay = null;
    state.rightDrag = null;
  };
}

function emitContextTap(event) {
  const target = event.target;
  if (!target?.emit) return;
  event.originalEvent?.preventDefault?.();
  target.emit({
    type: "cxttap",
    target,
    position: event.position,
    renderedPosition: event.renderedPosition,
    originalEvent: event.originalEvent,
    quasarGesture: "hold"
  });
}

function emitRelationDraft(cy, sourceNode, targetNode) {
  const sourceRendered = sourceNode.renderedPosition();
  const targetRendered = targetNode.renderedPosition();
  const renderedPosition = {
    x: (sourceRendered.x + targetRendered.x) / 2,
    y: (sourceRendered.y + targetRendered.y) / 2
  };
  const position = {
    x: (sourceNode.position().x + targetNode.position().x) / 2,
    y: (sourceNode.position().y + targetNode.position().y) / 2
  };
  const preview = cy.add({
    group: "edges",
    data: {
      id: `relation-preview-gesture-${sourceNode.id()}-${targetNode.id()}-${Date.now()}`,
      source: sourceNode.id(),
      target: targetNode.id()
    }
  });

  cy.emit({ type: "ehcomplete", target: cy, position, renderedPosition }, [
    sourceNode,
    targetNode,
    preview
  ]);
}

export function installGraphGestures(cy) {
  if (!cy || cy.scratch(GESTURE_SCRATCH)) return cy;

  const state = {
    armedNodeId: null,
    drag: null,
    panningEnabled: true,
    rightDrag: null,
    selectionOverlay: null,
    suppressContextTapUntil: 0,
    suppressContextTapTimer: null
  };
  cy.scratch(GESTURE_SCRATCH, state);

  const removeRightDragSelection = installRightDragSelection(cy, state);

  cy.on("tap", (event) => {
    if (event.target === cy) state.armedNodeId = null;
  });
  cy.on("tap", "node", (event) => {
    if (event.target.data("unresolved")) return;
    state.armedNodeId = event.target.id();
  });
  cy.on("unselect", "node", (event) => {
    if (state.armedNodeId === event.target.id()) state.armedNodeId = null;
  });
  cy.on("dragpan scrollzoom pinchzoom", () => {
    state.armedNodeId = null;
  });
  cy.on("grab", "node", (event) => {
    const node = event.target;
    if (node.data("unresolved")) return;
    const pointerType = pointerTypeFromEvent(event);
    state.panningEnabled = cy.panningEnabled();
    cy.panningEnabled(false);
    state.drag = {
      id: node.id(),
      position: { ...node.position() },
      renderedPosition: { ...node.renderedPosition() },
      relationArmed: state.armedNodeId === node.id() && node.selected(),
      pointerType,
      moved: false
    };
    if (!node.selected()) selectSingleNode(cy, node);
  });
  cy.on("drag", "node", (event) => {
    if (!state.drag || state.drag.id !== event.target.id()) return;
    state.drag.moved =
      distanceSquared(state.drag.renderedPosition, event.target.renderedPosition()) >=
      DRAG_THRESHOLD_SQUARED;
  });
  cy.on("dragfree", "node", (event) => {
    const sourceNode = event.target;
    const drag = state.drag;
    state.drag = null;
    cy.panningEnabled(state.panningEnabled);
    if (!drag || drag.id !== sourceNode.id()) return;

    state.armedNodeId = sourceNode.id();
    if (!drag.moved || !drag.relationArmed) return;

    const targetNode = findRelationDropTarget(
      cy,
      sourceNode,
      relationDropPadding(drag.pointerType)
    );
    if (!targetNode) return;

    sourceNode.position(drag.position);
    state.armedNodeId = null;
    emitRelationDraft(cy, sourceNode, targetNode);
  });
  cy.on("free", "node", (event) => {
    if (!state.drag || state.drag.id !== event.target.id()) return;
    state.drag = null;
    cy.panningEnabled(state.panningEnabled);
    state.armedNodeId = event.target.id();
  });
  cy.on("taphold", (event) => {
    if (state.drag?.moved) return;
    emitContextTap(event);
  });
  cy.on("destroy", () => {
    removeRightDragSelection();
  });

  return cy;
}
