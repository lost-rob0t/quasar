# GPU graph renderer benchmark

Quasar's GPU renderer work is performance-gated. WebGL is available behind
`VITE_GRAPH_RENDERER=webgl` or `VITE_GRAPH_RENDERER=auto`, but Canvas remains the
default until measured browser results justify promotion.

## Renderer sweep

Run from the repository root:

```sh
npm run benchmark:graph-renderer
```

The default sweep measures sparse, pre-positioned graphs at:

```text
100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000,
8000, 12000, 16000, 24000, 32000, 50000 nodes
```

Each graph has approximately one edge per node. Pre-positioning intentionally
removes layout cost from this benchmark so the Canvas and WebGL renderers can be
compared directly.

The sweep records:

- time through the first settled browser frames;
- average and p95 pan frame time plus derived FPS;
- average and p95 zoom frame time plus derived FPS;
- time to add and render a one-percent graph mutation;
- renderer failures at each graph size rather than aborting the whole sweep;
- browser WebGL vendor/renderer information and whether it appears to be a
  software renderer.

For hardware numbers, run Chromium headed on the GPU-backed desktop:

```sh
QUASAR_GRAPH_BENCH_HEADLESS=0 npm run benchmark:graph-renderer
```

Headless runs are still useful for regression comparison, but the harness warns
when WebGL is backed by SwiftShader, llvmpipe, or another software renderer.

Write the complete result set as JSON with:

```sh
QUASAR_GRAPH_BENCH_JSON=/tmp/quasar-graph-renderer.json \
  npm run benchmark:graph-renderer
```

Override the size sweep or motion sample count when doing focused runs:

```sh
QUASAR_GRAPH_BENCH_SIZES=1000,2000,4000,8000,16000 \
QUASAR_GRAPH_BENCH_FRAMES=60 \
  npm run benchmark:graph-renderer
```

## Existing CPU/layout baseline

`npm run benchmark:graph` remains the CPU/headless graph-model and layout
benchmark. Do not mix its COSE/grid timings into renderer conclusions. Renderer
performance and layout/compute performance are separate optimization tracks.

## Promotion gate

Before changing Quasar's default from Canvas to `auto`, collect hardware-backed
results and verify all of the following:

1. No renderer/style/interaction regressions in graph E2E tests.
2. WebGL does not materially regress first-frame or mutation cost at the current
   4,000-node production scale boundary.
3. Pan and zoom results improve enough at larger graph sizes to justify the
   experimental renderer and its compatibility risk.
4. The measured crossover point is documented so Quasar can later choose the
   renderer by graph size if that beats a single global default.

The benchmark intentionally continues well past Quasar's current production
cutoff. Those larger sizes measure renderer headroom only; they do not remove the
need for incremental graph patching, bounded neighborhood queries, level of
detail, or viewport-driven loading.
