# Agent config packs

Quasar can bulk-import agent configurations from the existing **Import JSON** control in the agent console.

## Format

```json
{
  "format": "quasar-agent-pack",
  "version": 1,
  "name": "Investigation operators",
  "description": "Roles and agents for a bounded investigation workflow.",
  "roles": [],
  "agents": [],
  "providers": [],
  "models": [],
  "budgets": [],
  "skills": [],
  "mcpServers": []
}
```

Only `format`, `version`, and at least one supported array are needed. Missing arrays are treated as empty.

## Agents

Agents use the same fields as the agent editor. Packs may use either camelCase or the compact aliases shown below:

- `roleId` or `role`
- `providerId` or `provider`
- `modelId` or `model`
- `systemPrompt` or `system_prompt`

`modelId` must be non-empty. An imported agent may reference a role included in the same pack or a role already installed in Quasar.

## Roles

Role instructions are imported from `instructions`. `systemPrompt` and `system_prompt` are accepted as aliases for role instructions.

Roles are written before agents so a pack can define and immediately use its own roles.

## Validation

Import is rejected before any records are written when:

- the format or version is unsupported;
- a record ID is duplicated within the pack;
- a permission is unknown;
- an agent references a role that is neither installed nor included in the pack;
- the pack contains secret-bearing fields such as `apiKey`, `secret`, `accessToken`, `authorization`, or `password`.

Provider keys and MCP credentials must be entered in Quasar after import. They are never accepted from a pack.

## Conflicts

The agent console currently uses the safe `error` conflict mode: if any imported ID already exists, nothing is applied and the UI reports the conflicts.

The importer also supports programmatic `skip` and `replace` modes for future UI workflows.

## Compatibility

Legacy `quasar-agent-system` exports remain importable.
