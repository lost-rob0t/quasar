actor_registry_authority(starintel_server).

actor_registry_http_contract(
    'starintel-actor-registry-v1',
    get,
    '/v1/actors',
    'actors:read').

actor_registry_status(online).
actor_registry_status('declared-offline').
actor_registry_status(degraded).
actor_registry_status(unavailable).
actor_registry_alive(online, true).

quasar_actor_registry_responsibility(projection_only).
quasar_actor_registry_invariant(no_parallel_registry).
quasar_actor_registry_invariant(no_browser_execution_of_server_actors).
quasar_actor_registry_invariant(selectable_rows_remain_buttons).

actor_registry_ui_accessibility(
    labeled_list_of_buttons,
    'Actor rows use button semantics with aria-pressed; role=option would hide the existing New actor action from button-based editor interactions.').

verified_against(
    actor_registry_http_contract,
    github_pull_request('lost-rob0t/starintel-server', 152,
                        'af8f7deb8ff40a628c8c1e7ea2710318e265787d')).
