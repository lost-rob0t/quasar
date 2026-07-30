import cytoscape from "cytoscape";
import edgehandles from "cytoscape-edgehandles";
import { installGraphGestures } from "./graph-gestures";
import { installMaltegoLayouts } from "./maltego-layouts";
import { installUserNavigationGuard } from "./user-navigation-guard";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const AUTO_NODE_SPACING = 96;
const NODE_SIZE_SAMPLE_LIMIT = 16;
export const DEFAULT_WHEEL_SENSITIVITY = 0.42;
export const MAX_WHEEL_SENSITIVITY = 4;
export const TARGET_RENDERED_NODE_SIZE = 38;

let pluginsRegistered = false;

function registerPlugins() {
  if (pluginsRegistered) return;
  cytoscape.use(edgehandles);
  pluginsRegistered = true;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function adaptiveWheelSensitivity(renderedNodeSize, deltaY) {
  const size = Number(renderedNodeSize);
  const delta = Number(deltaY);

  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(delta) || delta === 0) {
    return DEFAULT_WHEEL_SENSITIVITY;
  }

  const directionalRatio =
    delta < 0 ? TARGET_RENDERED_NODE_SIZE / size : size / TARGET_RENDERED_NODE_SIZE;
  const scale = Math.pow(Math.max(1, directionalRatio), 0.75);

  return clamp(DEFAULT_WHEEL_SENSITIVITY * scale, DEFAULT_WHEEL_SENSITIVITY, MAX_WHEEL_SENSITIVITY);
}

function sampleRenderedNodeSize(cy) {
  const nodes = cy.nodes();
  const sizes = [];
  const sampleCount = Math.min(nodes.length, NODE_SIZE_SAMPLE_LIMIT);

  for (let index = 0; index < sampleCount; index += 1) {
    const node = nodes[index];
    const size = Math.max(node.renderedOuterWidth(), node.renderedOuterHeight());
    if (Number.isFinite(size) && size > 0) sizes.push(size);
  }

  if (sizes.length === 0) return TARGET_RENDERED_NODE_SIZE;
  sizes.sort((left, right) => left - right);
  return sizes[Math.floor(sizes.length / 2)];
}

function installAdaptiveWheelSensitivity(cy, container, allowZoom) {
  if (!allowZoom || !container?.addEventListener) return () => {};

  const renderer = cy.renderer?.();
  if (!renderer) return () => {};

  const updateWheelSensitivity = (event) => {
    const sensitivity = adaptiveWheelSensitivity(sampleRenderedNodeSize(cy), event.deltaY);
    renderer.wheelSensitivity = sensitivity;
    if (container.dataset) container.dataset.graphWheelSensitivity = String(sensitivity);
  };

  container.addEventListener("wheel", updateWheelSensitivity, { capture: true, passive: true });
  return () => container.removeEventListener("wheel", updateWheelSensitivity, true);
}

export function automaticNodePosition(index, extent) {
  const safeIndex = Math.max(0, Number(index) || 0);
  const centerX = (Number(extent?.x1) + Number(extent?.x2)) / 2;
  const centerY = (Number(extent?.y1) + Number(extent?.y2)) / 2;
  const radius = AUTO_NODE_SPACING * Math.sqrt(safeIndex + 1);
  const angle = safeIndex * GOLDEN_ANGLE;

  return {
    x: (Number.isFinite(centerX) ? centerX : 0) + Math.cos(angle) * radius,
    y: (Number.isFinite(centerY) ? centerY : 0) + Math.sin(angle) * radius
  };
}

function hasPosition(node) {
  const position = node.position();
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    (Math.abs(position.x) > 0.001 || Math.abs(position.y) > 0.001)
  );
}

function installAutomaticNodePlacement(cy) {
  let automaticIndex = 0;

  cy.on("remove", "node", () => {
    if (cy.nodes().length === 0) automaticIndex = 0;
  });

  cy.on("add", "node", (event) => {
    const node = event.target;
    if (hasPosition(node)) return;
    node.position(automaticNodePosition(automaticIndex, cy.extent()));
    automaticIndex += 1;
  });

  return cy;
}

function installViewportInput(cy, options) {
  const container = options.container;
  const allowPan = options.panningEnabled !== false && options.userPanningEnabled !== false;
  const allowZoom = options.zoomingEnabled !== false && options.userZoomingEnabled !== false;

  cy.panningEnabled(options.panningEnabled !== false);
  cy.userPanningEnabled(allowPan);
  cy.zoomingEnabled(options.zoomingEnabled !== false);
  cy.userZoomingEnabled(allowZoom);
  cy.boxSelectionEnabled(false);

  if (!container?.addEventListener) return cy;

  const restoreWheelSensitivity = installAdaptiveWheelSensitivity(cy, container, allowZoom);
  const syncViewportState = () => {
    const pan = cy.pan();
    container.dataset.graphPanX = String(pan.x);
    container.dataset.graphPanY = String(pan.y);
    container.dataset.graphZoom = String(cy.zoom());
  };

  const cleanup = () => {
    cy.off("pan zoom", syncViewportState);
    restoreWheelSensitivity();
  };

  cy.on("pan zoom", syncViewportState);
  cy.one("destroy", cleanup);
  syncViewportState();
  return cy;
}

function exposeDevelopmentGraph(cy) {
  const container = cy.container?.();
  if ((!import.meta.env.DEV && import.meta.env.VITE_E2E !== "true") || !container) return;

  Object.defineProperty(container, "__quasarGraphAdapter", {
    configurable: true,
    value: cy
  });
  cy.one("destroy", () => {
    delete container.__quasarGraphAdapter;
  });
}

export class GraphAdapter {
  static create(options) {
    registerPlugins();
    const cy = installMaltegoLayouts(
      cytoscape({
        panningEnabled: true,
        userPanningEnabled: true,
        zoomingEnabled: true,
        userZoomingEnabled: true,
        wheelSensitivity: DEFAULT_WHEEL_SENSITIVITY,
        ...options,
        selectionType: "single"
      })
    );
    const restoreUserNavigation = installUserNavigationGuard(cy);
    cy.one("destroy", restoreUserNavigation);
    installAutomaticNodePlacement(cy);
    installGraphGestures(cy);
    exposeDevelopmentGraph(cy);
    return installViewportInput(cy, options);
  }
}

export function createGraphAdapter(options) {
  return GraphAdapter.create(options);
}
