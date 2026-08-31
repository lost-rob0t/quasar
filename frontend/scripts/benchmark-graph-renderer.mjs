import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const DEFAULT_SIZES = [
  100,
  250,
  500,
  750,
  1_000,
  1_500,
  2_000,
  3_000,
  4_000,
  6_000,
  8_000,
  12_000,
  16_000,
  24_000,
  32_000,
  50_000
];

function parsePositiveIntegers(value, fallback) {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function tableRows(rows) {
  return rows.map((row) => ({
    backend: row.backend,
    nodes: row.nodes,
    elements: row.elements,
    firstFrameMs: rounded(row.firstFrameMs),
    panFps: rounded(row.panFps),
    panP95Ms: rounded(row.panP95Ms),
    zoomFps: rounded(row.zoomFps),
    zoomP95Ms: rounded(row.zoomP95Ms),
    mutationCount: row.mutationCount,
    mutationMs: rounded(row.mutationMs),
    error: row.error || ""
  }));
}

function comparisonRows(rows) {
  const bySize = new Map();
  for (const row of rows) {
    const pair = bySize.get(row.nodes) || {};
    pair[row.backend] = row;
    bySize.set(row.nodes, pair);
  }

  return [...bySize.entries()]
    .filter(([, pair]) => pair.canvas && pair.webgl && !pair.canvas.error && !pair.webgl.error)
    .map(([nodes, pair]) => ({
      nodes,
      firstFrameSpeedup: rounded(pair.canvas.firstFrameMs / pair.webgl.firstFrameMs),
      panFpsSpeedup: rounded(pair.webgl.panFps / pair.canvas.panFps),
      zoomFpsSpeedup: rounded(pair.webgl.zoomFps / pair.canvas.zoomFps),
      mutationSpeedup: rounded(pair.canvas.mutationMs / pair.webgl.mutationMs)
    }));
}

const sizes = parsePositiveIntegers(process.env.QUASAR_GRAPH_BENCH_SIZES, DEFAULT_SIZES);
const motionFrames = Number.parseInt(process.env.QUASAR_GRAPH_BENCH_FRAMES || "24", 10);
const headless = process.env.QUASAR_GRAPH_BENCH_HEADLESS !== "0";
const root = fileURLToPath(new URL("..", import.meta.url));

const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false }
});

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 5173;

  browser = await chromium.launch({
    headless,
    args: ["--enable-gpu"]
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/benchmarks/graph-renderer.html`, {
    waitUntil: "networkidle"
  });
  await page.waitForFunction(() => typeof window.runQuasarGraphRendererBenchmark === "function");

  const result = await page.evaluate(
    ({ benchmarkSizes, frames }) =>
      window.runQuasarGraphRendererBenchmark({ sizes: benchmarkSizes, motionFrames: frames }),
    { benchmarkSizes: sizes, frames: motionFrames }
  );

  console.log("\nGPU context");
  console.table([result.gpu]);
  if (result.gpu.software) {
    console.warn("WARNING: browser reports a software WebGL renderer; rerun headed on a GPU-backed desktop for hardware numbers.");
  }

  console.log("\nCanvas vs WebGL renderer sweep");
  console.table(tableRows(result.rows));

  const comparisons = comparisonRows(result.rows);
  if (comparisons.length > 0) {
    console.log("\nWebGL speedup (greater than 1.0 is better)");
    console.table(comparisons);
  }

  if (process.env.QUASAR_GRAPH_BENCH_JSON) {
    await writeFile(
      process.env.QUASAR_GRAPH_BENCH_JSON,
      `${JSON.stringify({ ...result, comparisons }, null, 2)}\n`,
      "utf8"
    );
  }
} finally {
  await browser?.close();
  await server.close();
}
