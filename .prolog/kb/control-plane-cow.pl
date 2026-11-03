%% Control-plane mutation architecture (verified 2026-10-06, HEAD 53898ff).
%% Copy-on-write candidate isolation for ordinary mutations.

workspace_slot(documents, hash_table_equal_keys).
workspace_slot(graphs, hash_table_equal_keys).
workspace_slot(settings, hash_table_equal_keys).
workspace_slot(owned_graphs, 'per-instance set of graph ids this workspace may mutate in place').

cow_rule(candidate_shares_values,
         'copy-workspace copies hash tables and shares document, graph and setting values with the source').
cow_rule(graph_mutation_clones_first,
         'private-graph/2 clones a graph before its first structural mutation unless the workspace owns it').
cow_rule(document_ops_replace,
         'document create/update/restore store fresh clones; delete remhashes; no shared document is mutated in place').
cow_rule(graph_put_owned,
         'apply-graph-put installs a fresh canonical clone and marks the graph id owned').
cow_rule(journal_is_store_state,
         'the workspace object carries no journal; store-journal-entries/2 is the only journal reader').

memory_store_isolation('memory-store deep-copies document and graph values at load/save/commit to model durable storage').
tek9_commit_shape('commit-workspace applies typed persistence-change records in one write transaction; no corpus rewrite').

mutation_allocation_bound(changed_records_plus_table_entries).
measured_consing(corpus_4000_nested_docs, copy_workspace_bytes(638480), corpus_clone_bytes(12798720)).

graph_metadata_upsert_caveat('each graph-mutating op upserts one graph metadata record including positions; bounded by that graph metadata, not the corpus').
load_workspace_caveat('load-workspace still restores the full corpus into the live workspace cache once per process; issue #24 remains open for lazy restore').
