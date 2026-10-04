% Verified editor layout contracts.
editor_surface(full_document_editor).
fullscreen_trigger(full_document_editor, advanced_document_route).
fullscreen_contract(full_document_editor, owns_entire_viewport).
fullscreen_contract(full_document_editor, hides_global_shell_chrome).
fullscreen_contract(full_document_editor, provides_local_close_control).
browser_acceptance(full_document_editor, viewport_bounds_equal_window_bounds).
knowledge_source(full_document_editor, task('fullscreen-document-editor')).
