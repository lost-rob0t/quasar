# Bounded read measurements

Measured 2026-10-10 on Linux, SBCL 2.6.6, Nix shell and the flake-pinned Tek9
`ca24ef35ea6877420cbca057dd7fb702fe29a740`. Base Quasar commit:
`8199962373a9733b6dddda54e25ee6a7508cd835` plus the bounded-read changes.
Machine-readable recorded values are in
[`bounded-read-measurements.json`](bounded-read-measurements.json).

## Reproduction

```sh
nix develop --command npm run test:lisp
nix develop --command bash scripts/benchmark-bounded-reads
```

Serialize these commands: they share an ASDF output cache. Each benchmark fixture
uses a separate SBCL process and isolated temporary full-durability Tek9 store.
Fixtures contain 10,000 or 100,000 canonical records across two datasets, with
256-byte extension bodies. Fixture creation writes bounded 128-record batches
and is excluded from operation timers. The store is closed/reopened before
measurements. This is a process/store-cold read, **not** a dropped OS page cache.

The instrumentation path fails if a new read calls workspace hydration/cloning,
graph enumeration/restoration, or an unlimited primary scan. Ten 50-record
queries make exactly 500 bounded range calls at both fixture sizes; the
exclusive-seek lookahead can decode the preceding record too.

## Results

Decimal MB/GB below refer to allocations, not live heap or RSS.

| Operation | 10k elapsed | 100k elapsed | 10k allocated | 100k allocated | Returned/transferred bytes (10k / 100k) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Metadata bootstrap | 1 ms | 1 ms | 0.120 MB | 0.130 MB | 175 / 176 |
| First 50-record search | 7 ms | 7 ms | 3.401 MB | 2.743 MB | 5,611 / 5,611 |
| Ten repeated 50-record searches | 15 ms | 15 ms | 12.220 MB | 11.304 MB | 5,611 per final page |
| No-match scan, 1,000-record budget | 18 ms | 20 ms | 17.037 MB | 16.156 MB | 462 / 462 |
| Legacy snapshot page drain | 678 ms | 39,162 ms | 0.687 GB | 34.637 GB | 4,085,748 / 41,057,311 |
| Legacy full workspace load + copy | 110 ms | 1,088 ms | 80.168 MB | 806.374 MB | no wire response |

The legacy drain is an intentionally eager baseline using the real Phase 2
snapshot page API, 512 KiB pages, and retaining every document, matching the
client's page-collection algorithm. It performs 8 / 79 page fetches. High ordinal
offsets repeatedly decode earlier documents, so total allocation/time grows
faster than the corpus. This benchmark retains results in Lisp; it is **not a
browser JS heap measurement** or a measured Ready time.

The load-and-copy baseline exercises the real primitives used by ordinary
mutations. It is not a claim that mutation has been fixed, nor a complete import
or graph-edit benchmark. Both baselines remain active in compatibility/UI paths.

## Live heap and process samples

| Operation | Retained heap delta, 10k / 100k | RSS after, 10k / 100k |
| --- | ---: | ---: |
| Bootstrap | 5,760 / 6,528 B | 213,331,968 / 205,385,728 B |
| First search | 82,304 / 110,336 B | 213,426,176 / 205,295,616 B |
| Ten searches | 92,160 / 93,568 B | 213,852,160 / 206,061,568 B |
| No-match bounded scan | 4,608 / 4,096 B | 214,016,000 / 206,254,080 B |
| Legacy drain | 28,226,176 / 282,694,656 B | 293,617,664 / 647,114,752 B |
| Legacy load + copy | 27,414,688 / 274,177,456 B | 255,647,744 / 719,376,384 B |

Allocation is measured with `sb-ext:get-bytes-consed`; heap observations use
`sb-kernel:dynamic-usage` before work, before GC, and after a full GC while the
result remains live. Small retained deltas include runtime/GC noise. RSS,
anonymous/file-backed RSS and process high-water samples come from
`/proc/self/status`. RSS includes mapped Tek9 pages and native/runtime memory;
it is not SBCL live heap. Samples are before/after operations, not independently
sampled per-operation peaks. Process high-water marks also include fixture setup
and earlier operations and must not be presented as isolated query peaks.

The automated allocation gate warms the implementation then compares a fixed
50-record page against 10k/100k stores. It requires less than 8 MiB allocation,
less than 512 KiB retained-heap growth, and at most 2x + 64 KiB allocation growth
when corpus size increases 10x. It additionally checks the real page count and
forbidden call paths. Repeated search and bounded no-match scans are measured
separately, so a small WebSocket response is not the only evidence.

## Interpretation and remaining acceptance

These results verify bounded backend working sets for the new read endpoints.
They do not prove bounded startup for the existing React provider. Browser heap,
rendered elements, outstanding request limits, UI cache eviction, dataset/graph
catalogs, incremental named-graph loading, ordinary mutation overlays, graph
workflow cancellation/queue depth, and responsive full-graph analysis still need
their dependent implementations and real-stack benchmarks.

The full mission's acceptance checklist remains open as detailed in
[BOUNDED-WORKBENCH.md](BOUNDED-WORKBENCH.md).
