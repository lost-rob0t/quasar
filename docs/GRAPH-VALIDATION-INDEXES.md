# Graph validation and transaction-local array indexes (#113)

`graph.put` retains the node hash built during duplicate validation for both
endpoint checks. Expected ID-membership work is V + 3E probes rather than EV
linear comparisons; hash construction and auxiliary space are O(V+E). This is
submitted-graph complexity, not a bound on full-workspace loading or cloning.

Both definitions of `commit-operations` bind a fresh EQ table. Each node/edge
array receives an EQUAL ID table and a tail pointer on first use. Appending a
node or edge then uses one membership probe and one constant-time tail append,
preserving canonical order and the existing JSON representation. Existing arrays
are indexed once per uninterrupted insertion run. Endpoint lookup uses the same
node index. Non-insertion dispatch invalidates the context before mutation;
replace/remove helpers also invalidate the affected arrays. Destructive mixed
workloads can rebuild indexes and are not claimed to be linear overall.

## #78 interface and ownership

The #78 handoff on issue #113 explicitly leaves workspace.lisp to this workstream.
`graph-node`, `graph-edge`, and `dispatch-operation` signatures are unchanged.
`require-valid-edge` accepts an optional node-ID table for graph.put validation.
The private `*graph-array-indexes*` context is never persisted or attached to a
canonical graph. An overlay dispatch loop can bind it to a fresh EQ hash table
for its isolated candidate, or call `commit-operations` to obtain that scope.
Do not mutate graph arrays behind a live context; use dispatch or invalidate it.
The #78 overlay integration and real rollback suite must run before merge.

Only workspace.lisp, its diagnostic commit wrapper, and focused integrity tests
change. No store/catalog APIs, PR #110 branch, or Android PR #120 are changed.
Tek9 persistence and full durability remain untouched. Graph membership updates
for document-linked nodes and candidate cloning retain their existing costs;
this change does not claim to remove all transaction bottlenecks.

## Verification status

The integrity suite now asserts 4N membership probes for V=E=N at 32, 128, and
512, with endpoints ordered adversarially. Expected counts are 128, 512, and
2048; these are assertions, **not measured runtime results**. Bulk construction
also asserts zero existing-element build visits for initially empty arrays and
2N indexed tail appends. Tests cover duplicate nodes/edges, dangling endpoints,
wrong graph IDs, invalid relation references, ordered insertion, mixed
update/delete/recreation, and failed candidate isolation on a pre-existing graph.
Existing graph/transaction tests remain enabled by `npm run test:lisp`.

Executed: `git diff --check` and static string/parenthesis balancing for changed
Lisp files. These passed and are not substitutes for Lisp execution.
Attempted: `nix develop --command npm run test:lisp`; exit 127 because `nix` is
not installed. No SBCL/CLISP/ECL executable is available either. The exact-head
Lisp suite, Tek9 rollback/event assertions, #115 integration, and runtime
counter measurements remain unrun. This PR must stay draft pending those checks.
