% Documents workspace usability findings and fixes.
:- multifile usability_issue/3, usability_fix/2, usability_source/2.
usability_issue(documents_search_history, documents, back_button_traverses_query_keystrokes).
usability_issue(documents_empty_state, documents, empty_corpus_described_as_failed_filter).
usability_issue(documents_release_copy, documents, hardcoded_release_outlives_consumer_lock).
usability_issue(document_list_context, documents, detail_navigation_discards_list_filters).

usability_fix(documents_search_history, replace_query_url_entry).
usability_fix(documents_empty_state, distinguish_empty_corpus_from_filtered_results).
usability_fix(documents_release_copy, version_neutral_intro).
usability_fix(document_list_context, carry_list_location_through_detail_and_edit).
usability_source(documents_search_history, 'frontend/src/components/Documents.jsx').
usability_source(documents_empty_state, 'frontend/src/components/Documents.jsx').
usability_source(documents_release_copy, 'vendor/star-cl/schema/starintel-schema.lock.json').
usability_source(document_list_context, 'frontend/src/components/Documents.jsx').
