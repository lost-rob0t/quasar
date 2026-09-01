import { GRAPH_STYLE } from "../lib/graph-style";
import { createGraphAdapter } from "./GraphAdapter";

export const DEFAULT_RENDERER_BENCHMARK_SIZES = [
  100, 250, 500, 750, 1_000, 1_500, 2_000, 3_000, 4_000, 6_000, 8_000, 12_000, 16_000, 24_000,
  32_000, 50_000
];

const NODE_SPACING = 64;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function settleFrames(count = 2) {
  for (let index = 0; index < count; index += 1) await nextFrame();
}

function waitForRender(cy) {
  return new Promise((resolve) => {
    cy.one("render", () => resolve(performance.now()));
  });
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * quantile));
  return sorted[index];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function makeElements(nodeCount) {
  const columns = Math.ceil(Math.sqrt(nodeCount));
  const elements = [];

  for (let index = 0; index < nodeCount; index += 1) {
    elements.push({
      data: {
        id: `node:${index}`,
        label: `Node ${index}`,
        color: index % 7 === 0 ? "#38bdf8" : "#46617f",
        shape: index % 11 === 0 ? "diamond" : "ellipse",
        dtype: "entity"
      },
      position: {
        x: (index % columns) * NODE_SPACING,
        y: Math.floor(index / columns) * NODE_SPACING
      }
    });
  }

  for (let index = 1; index < nodeCount; index += 1) {
    elements.push({
      data: {
        id: `edge:${index}`,
        source: `node:${index - 1}`,
        target: `node:${index}`,
        directed: true,
        label: index % 8 === 0 ? "relation" : ""
      }
    });
  }

  return elements;
}

function createContainer(root) {
  root.replaceChildren();
  const container = document.createElement("div");
  container.style.width = "1600px";
  container.style.height = "900px";
  container.style.position = "relative";
  root.append(container);
  return container;
}

function getGpuInfo() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return { supported: false, vendor: null, renderer: null, software: false };

    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = extension
      ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR);
    const renderer = extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const text = `${vendor || ""} ${renderer || ""}`.toLowerCase();

    return {
      supported: true,
      vendor,
      renderer,
      software: /swiftshader|llvmpipe|software/.test(text)
    };
  } catch {
    return { supported: false, vendor: null, renderer: null, software: false };
  }
}

async function measureMotion(cy, frameCount, mutateViewport) {
  const renderTimes = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const started = performance.now();
    const rendered = waitForRender(cy);
    mutateViewport(frame);
    await rendered;
    renderTimes.push(performance.now() - started);
  }

  const averageMs = mean(renderTimes);
  return {
    averageMs,
    p95Ms: percentile(renderTimes, 0.95),
    fps: averageMs > 0 ? 1_000 / averageMs : 0
  };
}

async function benchmarkCase({ root, backend, nodes, motionFrames }) {
  const container = createContainer(root);
  const elements = makeElements(nodes);
  let cy;

  try {
    const started = performance.now();
    cy = createGraphAdapter({
      container,
      elements,
      style: GRAPH_STYLE,
      layout: { name: "preset" },
      pixelRatio: 1,
      rendererPreference: backend,
      minZoom: 0.01,
      maxZoom: 8,
      motionBlur: false
    });

    await settleFrames(2);
    const firstFrameMs = performance.now() - started;
    const actualBackend = container.dataset.graphRenderer || backend;
    const rendererFallback = container.dataset.graphRendererFallback === "true";
    const performanceTier = container.dataset.graphPerformanceTier || "normal";

    const pan = await measureMotion(cy, motionFrames, (frame) => {
      cy.panBy({ x: frame % 2 === 0 ? 8 : -8, y: frame % 3 === 0 ? 4 : -4 });
    });

    const zoomStart = cy.zoom();
    const zoom = await measureMotion(cy, motionFrames, (frame) => {
      const factor = frame % 2 === 0 ? 1.015 : 1 / 1.015;
      cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: 800, y: 450 } });
    });
    const zoomResetRender = waitForRender(cy);
    cy.zoom(zoomStart);
    await zoomResetRender;

    const mutationCount = Math.max(1, Math.floor(nodes * 0.01));
    const mutationElements = [];
    for (let index = 0; index < mutationCount; index += 1) {
      const id = `mutation:${index}`;
      mutationElements.push({
        data: { id, label: id, color: "#f59e0b", shape: "ellipse", dtype: "entity" },
        position: { x: index * 4, y: -96 }
      });
      mutationElements.push({
        data: {
          id: `mutation-edge:${index}`,
          source: id,
          target: `node:${index % nodes}`,
          directed: true,
          label: "mutation"
        }
      });
    }

    const mutationStarted = performance.now();
    const mutationRendered = waitForRender(cy);
    cy.add(mutationElements);
    await mutationRendered;
    const mutationMs = performance.now() - mutationStarted;

    return {
      requestedBackend: backend,
      backend: actualBackend,
      rendererFallback,
      performanceTier,
      nodes,
      elements: elements.length,
      firstFrameMs,
      panAverageMs: pan.averageMs,
      panP95Ms: pan.p95Ms,
      panFps: pan.fps,
      zoomAverageMs: zoom.averageMs,
      zoomP95Ms: zoom.p95Ms,
      zoomFps: zoom.fps,
      mutationCount,
      mutationMs,
      error: null
    };
  } finally {
    cy?.destroy();
    root.replaceChildren();
    await settleFrames(1);
  }
}

function failureRow(backend, nodes, error) {
  return {
    requestedBackend: backend,
    backend,
    rendererFallback: false,
    performanceTier: null,
    nodes,
    elements: nodes * 2 - 1,
    firstFrameMs: null,
    panAverageMs: null,
    panP95Ms: null,
    panFps: null,
    zoomAverageMs: null,
    zoomP95Ms: null,
    zoomFps: null,
    mutationCount: Math.max(1, Math.floor(nodes * 0.01)),
    mutationMs: null,
    error: error instanceof Error ? error.message : String(error)
  };
}

export async function runQuasarGraphRendererBenchmark({
  sizes = DEFAULT_RENDERER_BENCHMARK_SIZES,
  backends = ["canvas", "webgl"],
  motionFrames = 24
} = {}) {
  const root = document.querySelector("#benchmark-root");
  if (!root) throw new Error("renderer benchmark root is missing");

  const gpu = getGpuInfo();
  const rows = [];

  for (const backend of backends) {
    if (backend === "webgl" && !gpu.supported) continue;
    for (const nodes of sizes) {
      try {
        rows.push(await benchmarkCase({ root, backend, nodes, motionFrames }));
      } catch (error) {
        rows.push(failureRow(backend, nodes, error));
      }
    }
  }

  return { gpu, rows };
}
