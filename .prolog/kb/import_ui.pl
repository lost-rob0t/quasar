quasar_import_ui_surface(source_controls, panel).
quasar_import_ui_control(source_format, stacked_field).
quasar_import_ui_control(dataset, stacked_field).
quasar_import_ui_accent(quasar_brand).

quasar_import_ui_invariant(desktop, upload_targets_share_row_geometry).
quasar_import_ui_invariant(mobile, upload_targets_stack_without_horizontal_overflow).
quasar_import_ui_invariant(all_viewports, queue_actions_follow_options).

verified_by(quasar_import_ui_alignment,
            playwright_test('frontend/e2e/import-form-alignment.spec.ts')).
