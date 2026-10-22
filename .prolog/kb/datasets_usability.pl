:- multifile usability_issue/3, usability_fix/2, usability_source/2.

usability_issue(datasets_empty_state, datasets, empty_corpus_described_as_failed_search).
usability_issue(datasets_search_reset, datasets, search_has_no_visible_reset).
usability_issue(datasets_legacy_route, datasets, legacy_index_lacks_empty_state_and_search_reset).

usability_fix(datasets_empty_state, distinguish_empty_corpus_from_filtered_results).
usability_fix(datasets_search_reset, clear_search_action).
usability_fix(datasets_legacy_route, align_legacy_index_empty_state_and_search_reset).

usability_source(datasets_empty_state, 'frontend/src/components/DatasetsPage.jsx').
usability_source(datasets_search_reset, 'frontend/src/components/DatasetsPage.jsx').
usability_source(datasets_legacy_route, 'frontend/src/components/Documents.jsx').
