% Verified editor layout contracts.
editor_surface(full_document_editor).
editor_surface(graph_workspace).
fullscreen_trigger(full_document_editor, advanced_document_route).
fullscreen_trigger(graph_workspace, full_viewport_toggle).
fullscreen_contract(full_document_editor, owns_entire_viewport).
fullscreen_contract(full_document_editor, hides_global_shell_chrome).
fullscreen_contract(full_document_editor, provides_local_close_control).
fullscreen_contract(graph_workspace, owns_entire_viewport).
fullscreen_contract(graph_workspace, hides_global_shell_chrome).
fullscreen_contract(graph_workspace, provides_local_exit_control).
editor_layout(full_document_editor, setup_context_rail).
editor_layout(full_document_editor, scrollable_field_canvas).
editor_layout(full_document_editor, anchored_save_actions).
browser_acceptance(full_document_editor, viewport_bounds_equal_window_bounds).
browser_acceptance(graph_workspace, viewport_bounds_equal_window_bounds).
knowledge_source(full_document_editor, task('graph-fullscreen-editor-redesign')).
knowledge_source(graph_workspace, task('graph-fullscreen-editor-redesign')).
