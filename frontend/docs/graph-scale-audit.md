# Graph scale audit

Measured on 2026-08-08 with Node 22 and Cytoscape 3.34 using
`npm run benchmark:graph`. The benchmark creates a sparse graph with one edge
per node and measures element insertion, grid layout, a 200-iteration COSE
force layout, and heap growth.

| Nodes | Elements | Add (ms) | Grid (ms) | COSE 200 (ms) | Heap (MB) |
| ----: | -------: | -------: | --------: | ------------: | --------: |
|   100 |      199 |      7.1 |       8.2 |          74.4 |       3.3 |
|   250 |      499 |      6.4 |      10.0 |         361.7 |      10.4 |
|   500 |      999 |      6.3 |      12.1 |       1,781.9 |      13.2 |
| 1,000 |    1,999 |     11.8 |      16.5 |       9,693.0 |      40.2 |
| 2,000 |    3,999 |     31.6 |     285.9 |       not run |      26.5 |
| 4,000 |    7,999 |    354.2 |     164.5 |       not run |      34.4 |
| 8,000 |   15,999 |    215.9 |     120.7 |       not run |      60.9 |

## Cutoffs

- COSE is automatically replaced by grid above 250 nodes. Even a reduced
  200-iteration run takes 1.8 seconds at 500 nodes and 9.7 seconds at 1,000.
- A graph is rejected before construction above 5,000 source documents, 4,000
  expanded nodes, or 8,000 total expanded elements. The 8,000-element point
  stayed below 600 ms for add plus grid layout and below 40 MB of headless heap
  in the benchmark. The limits leave headroom for the browser renderer, React,
  labels, document payloads, and mobile devices.
- Dataset scope is applied before graph construction. The all-documents view no
  longer builds the complete graph and filters it afterward when a dataset is
  selected.

These limits protect the current monolithic Cytoscape renderer. True corpus-wide
visualization above the cutoff still needs server-side neighborhood queries,
level-of-detail aggregation, and viewport tiling.

## Remaining audit findings

1. **High — corpus loading is still global.** `QuasarProvider` calls
   `listDocuments()`, which uses PouchDB `allDocs({ include_docs: true })`, and
   retains every canonical document in React state. The graph no longer builds
   or renders all of them, but very large corpora still pay the startup and heap
   cost. Replace this with count/index queries plus route-specific paged document
   loading.
2. **Medium — graph updates are full replacements.** `GraphCanvas` removes all
   Cytoscape elements and adds the complete visible set whenever the graph or a
   filter changes. Diff node and edge IDs and patch only additions, removals, and
   changed data before raising the hard cutoff.
3. **Medium — the production bundle is 1.59 MB minified.** Cytoscape, PouchDB,
   agents, and editors ship in the initial route chunk. Route-level dynamic
   imports would reduce startup time, especially on mobile.
4. **Architectural — corpus-wide graphs need level of detail.** A guard prevents
   browser failure; it does not make a million-record graph useful. The next
   scale tier should query bounded neighborhoods, aggregate clusters, and load
   viewport tiles from the server.
