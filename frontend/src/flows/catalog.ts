import type { Definition } from "./model";
const definitions: Definition[] = [
  {
    type: "inject",
    label: "Inject",
    category: "Input",
    inputs: {},
    outputs: { out: "json" },
    defaults: { payload: [1, 2, 3] },
    help: "Emit one configured JSON payload per preview run."
  },
  {
    type: "debug",
    label: "Debug",
    category: "Output",
    inputs: { in: "json" },
    outputs: {},
    defaults: {},
    help: "Collect payloads in the bounded preview log; never write workspace documents."
  },
  {
    type: "map",
    label: "Map",
    category: "Transform",
    inputs: { in: "array" },
    outputs: { out: "array" },
    defaults: { operation: "identity", path: "", value: 2 },
    help: "Map an array with identity, get (property path), add, multiply, or wrap. No eval."
  },
  {
    type: "filter",
    label: "Filter",
    category: "Routing",
    inputs: { in: "json" },
    outputs: { out: "json" },
    defaults: { path: "", operator: "gte", value: 2 },
    help: "Pass a matching payload, or retain matching array items. Operators: eq, neq, gt, gte, lt, lte, exists, contains."
  },
  {
    type: "switch",
    label: "Switch",
    category: "Routing",
    inputs: { in: "json" },
    outputs: { match: "json", otherwise: "json" },
    defaults: { path: "", operator: "eq", value: true },
    help: "Route each payload to match or otherwise using a declarative predicate."
  },
  {
    type: "change",
    label: "Change",
    category: "Transform",
    inputs: { in: "json" },
    outputs: { out: "json" },
    defaults: { field: "tag", value: "review" },
    help: "Set a top-level object field on a cloned payload."
  },
  {
    type: "split",
    label: "Split",
    category: "Sequence",
    inputs: { in: "array" },
    outputs: { out: "json" },
    defaults: {},
    help: "Emit each array item in stable order."
  },
  {
    type: "join",
    label: "Join",
    category: "Sequence",
    inputs: { in: "json" },
    outputs: { out: "array" },
    defaults: { count: 3 },
    help: "Collect exactly count payloads, emit an array, then reset. Incomplete groups fail the run."
  },
  {
    type: "concat",
    label: "Concat",
    category: "Sequence",
    inputs: { left: "array", right: "array" },
    outputs: { out: "array" },
    defaults: {},
    help: "FIFO pair left and right arrays and concatenate. Unpaired inputs fail the run."
  },
  {
    type: "merge",
    label: "Merge",
    category: "Routing",
    inputs: { in: "json" },
    outputs: { out: "json" },
    defaults: {},
    help: "Forward arrivals from any incoming edge; stable FIFO ordering."
  },
  {
    type: "dedup",
    label: "Deduplicate",
    category: "Routing",
    inputs: { in: "json" },
    outputs: { out: "json" },
    defaults: { path: "" },
    help: "Forward the first payload for each JSON-serialized key, scoped to this run."
  },
  {
    type: "take",
    label: "Take",
    category: "Routing",
    inputs: { in: "json" },
    outputs: { out: "json" },
    defaults: { count: 1 },
    help: "Forward at most count payloads per run."
  },
  {
    type: "delay",
    label: "Delay",
    category: "Sequence",
    inputs: { in: "json" },
    outputs: { out: "json" },
    defaults: { milliseconds: 50 },
    help: "Delay each arrival by 0–1000ms with cancellation. This is not a persistent scheduler."
  },
  {
    type: "json.parse",
    label: "JSON parse",
    category: "Transform",
    inputs: { in: "string" },
    outputs: { out: "json" },
    defaults: {},
    help: "Parse a JSON string; malformed input is an error."
  },
  {
    type: "json.stringify",
    label: "JSON stringify",
    category: "Transform",
    inputs: { in: "json" },
    outputs: { out: "string" },
    defaults: {},
    help: "Serialize a JSON payload."
  },
  {
    type: "starintel.validate",
    label: "StarIntel validate",
    category: "StarIntel",
    inputs: { in: "json" },
    outputs: { out: "document" },
    defaults: {},
    help: "Validate against the repository-locked canonical StarIntel schema. Does not migrate or persist."
  },
  {
    type: "starintel.field",
    label: "StarIntel field",
    category: "StarIntel",
    inputs: { in: "document" },
    outputs: { out: "json" },
    defaults: { path: "id" },
    help: "Read a canonical document field by own-property path."
  },
  ...["javascript", "lisp", "prolog", "starlang"].map((language) => ({
    type: `code.${language}`,
    label: `${language === "javascript" ? "JavaScript" : language === "starlang" ? "StarLang" : language === "lisp" ? "Common Lisp" : "Prolog"}`,
    category: "Code",
    inputs: { in: "json" as const },
    outputs: { out: "json" as const },
    defaults: {
      source:
        language === "javascript" ? "(payload) => payload" : "; Configure a trusted runtime adapter"
    },
    adapter: `code.${language}`,
    help:
      language === "javascript"
        ? "Explicitly enable isolated JavaScript for this session. Source is a function (payload) => JSON; runs in the existing opaque-origin sandbox without capabilities."
        : "Source is stored only. Requires a host-supplied trusted adapter and an explicit capability grant. No runtime is bundled."
  })),
  ...["rabbitmq", "zmq", "tcp", "http"].map((transport) => ({
    type: `transport.${transport}`,
    label: transport === "rabbitmq" ? "RabbitMQ" : transport.toUpperCase(),
    category: "Transport",
    inputs: { in: "json" as const },
    outputs: { out: "json" as const },
    defaults: { connectionRef: "", channel: "" },
    adapter: `transport.${transport}`,
    help: "Disabled without an explicitly granted trusted adapter. Use a connection reference resolved by the host, never inline credentials. One request/response per payload; not a live subscription."
  })),
  ...["search", "target", "actor"].map((operation) => ({
    type: `starintel.${operation}`,
    label: `StarIntel ${operation}`,
    category: "StarIntel",
    inputs: { in: "json" as const },
    outputs: { out: "json" as const },
    defaults: { connectionRef: "", name: "" },
    adapter: `starintel.${operation}`,
    help: "Disabled without an explicitly granted trusted host adapter. Existing server authorization remains authoritative; preview does not submit Targets or mutate the workspace."
  }))
];
// Every executable node has an explicit error route. Unwired errors stop the run.
export const CATALOG: readonly Definition[] = Object.freeze(
  definitions.map((def) => ({ ...def, outputs: { ...def.outputs, error: "json" as const } }))
);
export const registry: ReadonlyMap<string, Definition> = new Map(
  CATALOG.map((def) => [def.type, def])
);
