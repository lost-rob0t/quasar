bounded_read_command('workspace.bootstrap', metadata_only).
bounded_read_command('document.search', 'search-row.v1').
bounded_read_command('document.batch', canonical_records).
bounded_read_store_api(fetch, 'tek9:fetch*').
bounded_read_store_api(range, 'tek9:select-primary-range').
bounded_read_order(encoded_primary_key).
bounded_read_cursor_binding(workspace).
bounded_read_cursor_binding(revision).
bounded_read_cursor_binding(normalized_filters).
bounded_read_cursor_binding(last_scanned_key).
bounded_read_regression_suite('control-plane/tests/bounded-read-tests.lisp').
bounded_read_memory_gate('control-plane/tests/bounded-read-benchmark.lisp', [10000,100000]).
bounded_read_benchmark('nix develop --command bash scripts/benchmark-bounded-reads').
migration_boundary(frontend_startup, legacy_snapshot_drain).
migration_boundary(ordinary_mutations, full_workspace_candidate).
migration_boundary(graph_catalog, inline_membership_in_metadata).
asdf_launch_requirement(current_checkout_before_quicklisp).
asdf_launch_requirement(assert_selected_source_directory).
