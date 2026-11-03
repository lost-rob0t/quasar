# Geographic document workspace (first slice)

`/map` explores canonical StarIntel **0.10.1** point anchors and explicit geographic
relationships over an optional local OpenStreetMap basemap. The vendored StarLang
schema remains authoritative; no new canonical fields or records are introduced.
The StarIntel Geo draft informed direct/anchored semantics, but this point-only
slice does **not** claim full Geo profile conformance.

## Use

Open Map, zoom into a cell, then switch to individual points. Select a point to
inspect its canonical document and incoming geographic links. Locate any document
ID to follow up to three registered explicit links to point anchors. Related
records can be followed one page/hop at a time; the panel retains canonical
relation IDs and predicates. Direct and anchored locations remain distinct.
The document and existing graph focus routes are linked from the panel. Keyboard
arrow keys pan the focused map; +/- controls and dragging also work. URL
`anchor`, `lon`, `lat`, and `z` state supports document handoff and view links.

There is no geocoding or proximity-based inference. Coordinates are never copied
onto related documents. Unspecified accuracy stays unspecified. GeoPoint
latitude/longitude decimal strings, signs, WGS84 bounds and the antimeridian are
handled explicitly. Rendering clamps latitude to Web Mercator's limit; canonical
polar points remain indexed and queryable through the API.

### OpenStreetMap tiles

No external tile or geocoder request is enabled by default. Set the build-time
`VITE_OSM_TILE_TEMPLATE` to a same-origin XYZ path, for example:

```sh
VITE_OSM_TILE_TEMPLATE='/osm/{z}/{x}/{y}.png' npm run build
```

The deployment operator must serve that path from a self-hosted or licensed OSM
source. This patch does not install a tile service or proxy. Cross-origin,
credential-bearing, query-bearing and fragment-bearing templates are rejected.
Only currently visible tiles (maximum 96) are requested, with standard browser
caching; no offline/prefetch/downloader feature is provided. Attribution stays
visible. Additional provider attribution can be added by the deployment as its
source terms require.

Do not point the local route at community OSM tiles as a bulk-download workaround.
[OSMF's tile policy](https://operations.osmfoundation.org/policies/tiles/) requires
attribution and caching, forbids bulk/offline downloading from the standard tile
service, and says not to submit personal/confidential data to OSMF services. The
local-source default keeps document IDs, relation paths and viewport queries
inside Quasar.

## Storage and query contract

Tek9 owns canonical storage. Geo is a rebuildable projection inside the same
`:full` durable database, using exported Tek9 APIs only. Ordinary canonical
upserts/deletes, explicit workspace replacement and staged import promotion update
Geo in the **same transaction** as documents, revision and journal. Failed writes
expose neither changed points nor counts. Staged records stay invisible until
promotion. No reference fan-out is rewritten when an anchor moves.

The point index stores WGS84 rectangular cells at depths 0 through 14, plus a
bounded compact row per point at the deepest level. Depth 14 is about 0.022° by
0.011°; these are index cells, not OSM tile identities. Counts are per **direct
point anchor**, including co-located anchors. They are not counts of every related
document. Clusters cover whole intersecting cells, including cell portions beyond
the viewport; `countSemantics` and the UI state this explicitly.

Incoming/outgoing indexes retain canonical `geometry`/`location` references and
relation documents with these predicates:
`locatedAt`, `located-at`, `geolocated-at`, `observedAt`, `observed-at`,
`associatedWithPlace`, `associated-with-place`, `occupies`.
Only core-schema references inside the same authorized workspace are followed.
Strings containing addresses are never treated as exact coordinates. Dangling
participants are omitted from relationship results. Fixed-width lookup tokens
keep long IDs out of compound LMDB keys: reads verify exact identities and writes
fail atomically on a detected token collision. Tokens grant no access.

| Command | Request | Explicit bounds |
| --- | --- | --- |
| `geo.viewport` | `bbox: [west,south,east,north]`, integer `zoom: 0..22` | At most 256 intersecting cell reads/features; automatically coarsens depth |
| `geo.points` | `bbox`, optional `limit`, `cursor`, `scanLimit`, `deadlineMs` | At most 256 depth-14 cells, 100 returned points, 1000 scanned rows, 50 ms target, 512 KiB wire budget; wider areas return `geo.zoom-in` |
| `geo.related` | `id`, optional `limit`, `cursor` | One incoming hop; 50 results, 250 scans, 50 ms target, 512 KiB wire budget |
| `geo.resolve` | `id` | Outgoing traversal: 3 hops, 64 links/queue entries, 8 anchors, 50 ms target, 512 KiB wire budget; resource exhaustion reports `complete: false` |

Deadlines are cooperative: an individual Tek9 fetch/decode is not interruptible.
Largest-record decoding, tree depth, disk/cache misses and encoding remain costs.
Requests reject unknown options and invalid/non-finite coordinates. `west > east`
means an antimeridian crossing; `-180..180` covers the world, while equal bounds
mean a degenerate extent. +180 canonical points normalize to -180, and +180 query
endpoints include that meridian.

Point and relation cursors bind the workspace, revision and normalized query.
They are continuation state, not grants. Changed revisions require restarting;
wire data is bounded again after adding the envelope. UI pages replace rather
than accumulate previous pages. Pan, zoom, mode changes, disconnect/unmount and
selection changes discard superseded responses. Canonical detail/relation
revisions must agree with the selected projection.

WebSocket workspace and exact-command capability checks remain authoritative.
New read commands are in the existing standard local development capability list;
restricted/hosted sessions need explicit grants for each new command, and
`document.batch` for canonical detail. Registration never grants a hosted session
access. Geo inherits the current workspace-level read policy; it does not add
field-level or per-document policy enforcement that other reads do not have.

### Existing workspaces

Map reads never migrate/scan a nonempty old workspace. They return
`geo.index-required` until an operator runs explicit maintenance in the repository
Nix shell. With a store already opened by the host:

```lisp
(quasar.store:rebuild-geo-index store "workspace-id")
```

This is a local maintenance API, not an exposed browser command. It streams 32
canonical records at a time into an atomic rebuild and marks the index ready only
on success. It is O(N) work/disk and retains O(batch + largest record) heap. Its
single write transaction blocks other writers for the entire rebuild. Plan a
maintenance window; online, checkpointed background builds are future work.

## Measurements and validation

[geo-measurements.json](geo-measurements.json) contains raw 1k/10k/100k-anchor
measurements, runtime details and hashes of measured source. Each anchor has one
synthetic wireless-network record, giving 2k/20k/200k canonical documents. No live
WiGLE data, routes or collection were used. Seeding used the actual projection
hook plus exported Tek9 writes in one full-durability transaction. These store
measurements exclude HTTP/browser startup, concurrency and cold-cache costs.

At 200k documents, 30 warm sequential queries measured:

| Scenario | p50 | p95 | Returned | Index range rows decoded |
| --- | --- | --- | --- | --- |
| World clusters | 0.144 ms | 0.188 ms | 16 cells | 0 (16 cell point-fetches) |
| Dense point page | 3.457 ms | 4.486 ms | 100 points | 199 |
| Sparse point page | 0.064 ms | 0.125 ms | 1 point | 2 |
| Related network | 0.064 ms | 0.168 ms | 1 link | 2 |

Dense-page cumulative allocation was ~2.33 MB per query; the post-GC process Lisp
heap stayed around 66 MB across the three corpus sizes. This is **not total RSS**:
native memory, memory-mapped LMDB and the OS page cache are excluded. The 200k-doc
LMDB data file was 407,740,416 bytes and seed time about 26.2 seconds. Instrumented
queries reject workspace hydration and canonical primary scans; retained output
and scanned index rows stay bounded. These numbers do **not** prove full-WiGLE
scale, concurrent load capacity or the whole application's memory use.

Required commands (inside `nix develop --command ...`):

```sh
npm run test:lisp
bash scripts/benchmark-geo
npm run check
npm test
npm run build
npm --prefix frontend exec -- playwright test --config tests/browser/geo-map/playwright.config.ts
```

The dedicated Chromium journeys render the actual GeoWorkspace with synthetic
host replies and same-origin synthetic tile images. They exercise cell-to-point
paging, document/evidence/graph links, related-record navigation, delayed locate
versus selection/pan, repeated lookup, denied-read clearing, no external requests,
and a 390px viewport. They are not a live full-stack OSM/backend test.

Authoring environment: required Nix command failed with exit 127 (`nix` absent).
Supplemental host checks passed: 467 unit tests, 1 integration test, root static
checks, production build and 3 Chromium journeys. A separately extracted SBCL
2.2.9 plus the pinned Tek9 source ran store-level regressions for updates/deletes,
rollback/restart, staged promotion, long IDs, signed/invalid coordinates,
antimeridian endpoints, cursors/deadlines, relation paths and deterministic
rebuild. The full Lisp suite and new WebSocket authority regressions require the
Nix/full host environment and remain unverified here. Keep the PR draft until
required CI/Nix/full-stack checks are green.

## Remaining scope

- Base `main` still hydrates the corpus during application startup. Existing
  bounded-client integration PR #120 owns that migration; this branch does not
  duplicate or claim completion of it. Geo reads themselves never hydrate it.
- No LineString/Polygon rendering, address geocoder, temporal/as-of query,
  derived inference, MVT/PMTiles/offline packs, dataset-filtered count index,
  geographic editing or imported WiGLE bulk ingestion is included.
- Client-side pan rendering is intentionally simple; no inertia, pinch gesture
  or advanced map styling. An OSM-compatible local tile source must be supplied.
- Write amplification is 15 cell-count updates per changed point plus its leaf
  row, and two index rows per geographic link. Full rebuilds need disk/time and
  block the writer. Billions of records need separate capacity, bulk-load and
  partitioning measurements before deployment.
