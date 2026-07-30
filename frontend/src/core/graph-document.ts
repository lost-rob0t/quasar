import type { GraphPosition, GraphViewport, QuasarDocument } from "./types";
import { isStableIdentifier } from "./identifiers";
import {
  defaultTypeRegistry,
  propertyValueMatches,
  type EdgeTypeDefinition,
  type NodeTypeDefinition,
  type TypePropertyDefinition,
  type TypeRegistry
} from "./type-registry";

export const GRAPH_SCHEMA_VERSION = "1.0.0";

export type GraphExtensionFields = Record<string, unknown>;

export interface GraphMetadata {
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  typeLibraryRefs: string[];
  tags: string[];
  extensions: GraphExtensionFields;
  [field: string]: unknown;
}

export interface CanonicalGraphNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  position?: GraphPosition;
  createdAt: string;
  updatedAt: string;
  extensions: GraphExtensionFields;
  [field: string]: unknown;
}

export interface CanonicalGraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  directed: boolean;
  label?: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  extensions: GraphExtensionFields;
  [field: string]: unknown;
}

export interface GraphViewState {
  viewport: GraphViewport | null;
  layout: string;
  selectedIds: string[];
  extensions: GraphExtensionFields;
  [field: string]: unknown;
}

export interface CanonicalGraphDocument {
  schemaVersion: string;
  id: string;
  metadata: GraphMetadata;
  nodes: CanonicalGraphNode[];
  edges: CanonicalGraphEdge[];
  view: GraphViewState;
  extensions: GraphExtensionFields;
  [field: string]: unknown;
}

export interface CreateGraphDocumentInput {
  id: string;
  name: string;
  description?: string;
  timestamp?: string;
  typeLibraryRefs?: string[];
  tags?: string[];
  nodes?: CanonicalGraphNode[];
  edges?: CanonicalGraphEdge[];
  viewport?: GraphViewport | null;
  layout?: string;
  selectedIds?: string[];
  metadataExtensions?: GraphExtensionFields;
  viewExtensions?: GraphExtensionFields;
  extensions?: GraphExtensionFields;
}

export interface CreateGraphNodeInput {
  id: string;
  type: string;
  label: string;
  properties?: Record<string, unknown>;
  position?: GraphPosition;
  createdAt?: string;
  updatedAt?: string;
  extensions?: GraphExtensionFields;
}

export interface CreateGraphEdgeInput {
  id: string;
  type: string;
  source: string;
  target: string;
  directed?: boolean;
  label?: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  extensions?: GraphExtensionFields;
}

export type GraphValidationCode =
  | "dangling-edge"
  | "duplicate-id"
  | "endpoint-violation"
  | "invalid-graph"
  | "invalid-identifier"
  | "invalid-property"
  | "invalid-timestamp"
  | "invalid-view";

export interface GraphValidationIssue {
  code: GraphValidationCode;
  path: string;
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationIssue[];
  graph?: CanonicalGraphDocument;
}

export class GraphValidationError extends Error {
  readonly errors: GraphValidationIssue[];

  constructor(errors: GraphValidationIssue[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    this.name = "GraphValidationError";
    this.errors = errors;
  }
}

export interface GraphFromDocumentsOptions {
  id: string;
  name: string;
  description?: string;
  timestamp?: string;
  positions?: Record<string, GraphPosition>;
  viewport?: GraphViewport | null;
  layout?: string;
  selectedIds?: string[];
  typeLibraryRefs?: string[];
  extensions?: GraphExtensionFields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFinitePosition(value: unknown): value is GraphPosition {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepClone(item)])
    ) as T;
  }
  return value;
}

function timestamp(value?: string): string {
  return value ?? new Date().toISOString();
}

export function createGraphNode(input: CreateGraphNodeInput): CanonicalGraphNode {
  const createdAt = timestamp(input.createdAt);
  return {
    id: input.id,
    type: input.type,
    label: input.label,
    properties: deepClone(input.properties ?? {}),
    ...(input.position ? { position: deepClone(input.position) } : {}),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    extensions: deepClone(input.extensions ?? {})
  };
}

export function createGraphEdge(input: CreateGraphEdgeInput): CanonicalGraphEdge {
  const createdAt = timestamp(input.createdAt);
  return {
    id: input.id,
    type: input.type,
    source: input.source,
    target: input.target,
    directed: input.directed ?? true,
    ...(input.label ? { label: input.label } : {}),
    properties: deepClone(input.properties ?? {}),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    extensions: deepClone(input.extensions ?? {})
  };
}

export function createGraphDocument(input: CreateGraphDocumentInput): CanonicalGraphDocument {
  const createdAt = timestamp(input.timestamp);
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: input.id,
    metadata: {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      createdAt,
      updatedAt: createdAt,
      typeLibraryRefs: [...(input.typeLibraryRefs ?? [])],
      tags: [...(input.tags ?? [])],
      extensions: deepClone(input.metadataExtensions ?? {})
    },
    nodes: deepClone(input.nodes ?? []),
    edges: deepClone(input.edges ?? []),
    view: {
      viewport: input.viewport ? deepClone(input.viewport) : null,
      layout: input.layout ?? "preset",
      selectedIds: [...(input.selectedIds ?? [])],
      extensions: deepClone(input.viewExtensions ?? {})
    },
    extensions: deepClone(input.extensions ?? {})
  };
}

function addIssue(
  errors: GraphValidationIssue[],
  code: GraphValidationCode,
  path: string,
  message: string
): void {
  errors.push({ code, path, message });
}

function validateTimestamp(errors: GraphValidationIssue[], value: unknown, path: string): void {
  if (!isTimestamp(value))
    addIssue(errors, "invalid-timestamp", path, "must be an ISO-compatible timestamp");
}

function validatePropertyDefinitions(
  errors: GraphValidationIssue[],
  properties: Record<string, unknown>,
  definitions: readonly TypePropertyDefinition[],
  path: string
): void {
  for (const definition of definitions) {
    const value = properties[definition.key];
    if (value === undefined) {
      if (definition.required) {
        addIssue(errors, "invalid-property", `${path}.${definition.key}`, "is required");
      }
      continue;
    }
    if (!propertyValueMatches(value, definition.valueType)) {
      addIssue(
        errors,
        "invalid-property",
        `${path}.${definition.key}`,
        `must match ${definition.valueType}`
      );
    }
  }
}

function validateNode(
  errors: GraphValidationIssue[],
  value: unknown,
  index: number,
  registry: TypeRegistry
): { id?: string; type?: string } {
  const path = `nodes[${index}]`;
  if (!isRecord(value)) {
    addIssue(errors, "invalid-graph", path, "must be an object");
    return {};
  }

  if (!isStableIdentifier(value.id)) {
    addIssue(errors, "invalid-identifier", `${path}.id`, "must be a stable identifier");
  }
  if (!isStableIdentifier(value.type)) {
    addIssue(errors, "invalid-identifier", `${path}.type`, "must be a stable type identifier");
  }
  if (typeof value.label !== "string" || !value.label.trim()) {
    addIssue(errors, "invalid-graph", `${path}.label`, "must be a non-empty string");
  }
  if (!isRecord(value.properties)) {
    addIssue(errors, "invalid-property", `${path}.properties`, "must be an object");
  }
  if (value.position !== undefined && !isFinitePosition(value.position)) {
    addIssue(errors, "invalid-graph", `${path}.position`, "must contain finite x and y numbers");
  }
  validateTimestamp(errors, value.createdAt, `${path}.createdAt`);
  validateTimestamp(errors, value.updatedAt, `${path}.updatedAt`);

  if (isRecord(value.properties) && typeof value.type === "string") {
    const definition: NodeTypeDefinition | undefined = registry.getNodeType(value.type);
    if (definition) {
      validatePropertyDefinitions(
        errors,
        value.properties,
        definition.properties,
        `${path}.properties`
      );
    }
  }

  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {})
  };
}

function validateEdgeShape(
  errors: GraphValidationIssue[],
  value: unknown,
  index: number,
  registry: TypeRegistry
): { edge?: Record<string, unknown>; definition?: EdgeTypeDefinition } {
  const path = `edges[${index}]`;
  if (!isRecord(value)) {
    addIssue(errors, "invalid-graph", path, "must be an object");
    return {};
  }

  for (const field of ["id", "type", "source", "target"] as const) {
    if (!isStableIdentifier(value[field])) {
      addIssue(errors, "invalid-identifier", `${path}.${field}`, "must be a stable identifier");
    }
  }
  if (typeof value.directed !== "boolean") {
    addIssue(errors, "invalid-graph", `${path}.directed`, "must be a boolean");
  }
  if (value.label !== undefined && typeof value.label !== "string") {
    addIssue(errors, "invalid-graph", `${path}.label`, "must be a string when present");
  }
  if (!isRecord(value.properties)) {
    addIssue(errors, "invalid-property", `${path}.properties`, "must be an object");
  }
  validateTimestamp(errors, value.createdAt, `${path}.createdAt`);
  validateTimestamp(errors, value.updatedAt, `${path}.updatedAt`);

  const definition = typeof value.type === "string" ? registry.getEdgeType(value.type) : undefined;
  if (definition && isRecord(value.properties)) {
    validatePropertyDefinitions(
      errors,
      value.properties,
      definition.properties,
      `${path}.properties`
    );
  }

  return { edge: value, definition };
}

function validateEndpointConstraints(
  errors: GraphValidationIssue[],
  edge: Record<string, unknown>,
  definition: EdgeTypeDefinition | undefined,
  index: number,
  nodeTypes: Map<string, string>
): void {
  const path = `edges[${index}]`;
  if (typeof edge.source !== "string" || typeof edge.target !== "string") return;

  const sourceType = nodeTypes.get(edge.source);
  const targetType = nodeTypes.get(edge.target);
  if (!sourceType)
    addIssue(errors, "dangling-edge", `${path}.source`, `node ${edge.source} does not exist`);
  if (!targetType)
    addIssue(errors, "dangling-edge", `${path}.target`, `node ${edge.target} does not exist`);
  if (!sourceType || !targetType || !definition?.endpoints) return;

  const { sourceTypes, targetTypes, allowSelf } = definition.endpoints;
  if (edge.source === edge.target && allowSelf === false) {
    addIssue(errors, "endpoint-violation", path, `${definition.id} does not allow self edges`);
  }
  if (sourceTypes?.length && !sourceTypes.includes(sourceType)) {
    addIssue(
      errors,
      "endpoint-violation",
      `${path}.source`,
      `${definition.id} requires source type ${sourceTypes.join(" or ")}, received ${sourceType}`
    );
  }
  if (targetTypes?.length && !targetTypes.includes(targetType)) {
    addIssue(
      errors,
      "endpoint-violation",
      `${path}.target`,
      `${definition.id} requires target type ${targetTypes.join(" or ")}, received ${targetType}`
    );
  }
}

function validateView(errors: GraphValidationIssue[], value: unknown, nodeIds: Set<string>): void {
  if (!isRecord(value)) {
    addIssue(errors, "invalid-view", "view", "must be an object");
    return;
  }
  if (typeof value.layout !== "string" || !value.layout.trim()) {
    addIssue(errors, "invalid-view", "view.layout", "must be a non-empty string");
  }
  if (value.viewport !== null) {
    if (!isRecord(value.viewport)) {
      addIssue(errors, "invalid-view", "view.viewport", "must be null or an object");
    } else {
      if (
        typeof value.viewport.zoom !== "number" ||
        !Number.isFinite(value.viewport.zoom) ||
        value.viewport.zoom <= 0
      ) {
        addIssue(errors, "invalid-view", "view.viewport.zoom", "must be a positive finite number");
      }
      if (!isFinitePosition(value.viewport.pan)) {
        addIssue(
          errors,
          "invalid-view",
          "view.viewport.pan",
          "must contain finite x and y numbers"
        );
      }
    }
  }
  if (!Array.isArray(value.selectedIds)) {
    addIssue(errors, "invalid-view", "view.selectedIds", "must be an array");
  } else {
    const seen = new Set<string>();
    value.selectedIds.forEach((id, index) => {
      if (!isStableIdentifier(id)) {
        addIssue(
          errors,
          "invalid-identifier",
          `view.selectedIds[${index}]`,
          "must be a stable identifier"
        );
      } else if (!nodeIds.has(id)) {
        addIssue(errors, "invalid-view", `view.selectedIds[${index}]`, `node ${id} does not exist`);
      } else if (seen.has(id)) {
        addIssue(errors, "duplicate-id", `view.selectedIds[${index}]`, `duplicate selection ${id}`);
      }
      if (typeof id === "string") seen.add(id);
    });
  }
}

export function validateGraphDocument(
  value: unknown,
  registry: TypeRegistry = defaultTypeRegistry
): GraphValidationResult {
  const errors: GraphValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(errors, "invalid-graph", "$", "graph must be an object");
    return { valid: false, errors };
  }

  if (value.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    addIssue(errors, "invalid-graph", "schemaVersion", `must equal ${GRAPH_SCHEMA_VERSION}`);
  }
  if (!isStableIdentifier(value.id)) {
    addIssue(errors, "invalid-identifier", "id", "must be a stable graph identifier");
  }

  if (!isRecord(value.metadata)) {
    addIssue(errors, "invalid-graph", "metadata", "must be an object");
  } else {
    if (typeof value.metadata.name !== "string" || !value.metadata.name.trim()) {
      addIssue(errors, "invalid-graph", "metadata.name", "must be a non-empty string");
    }
    validateTimestamp(errors, value.metadata.createdAt, "metadata.createdAt");
    validateTimestamp(errors, value.metadata.updatedAt, "metadata.updatedAt");
    if (
      !Array.isArray(value.metadata.typeLibraryRefs) ||
      value.metadata.typeLibraryRefs.some((item) => typeof item !== "string" || !item.trim())
    ) {
      addIssue(
        errors,
        "invalid-graph",
        "metadata.typeLibraryRefs",
        "must be an array of non-empty strings"
      );
    }
    if (
      !Array.isArray(value.metadata.tags) ||
      value.metadata.tags.some((item) => typeof item !== "string")
    ) {
      addIssue(errors, "invalid-graph", "metadata.tags", "must be an array of strings");
    }
  }

  const nodeIds = new Set<string>();
  const allIds = new Set<string>();
  const nodeTypes = new Map<string, string>();
  if (!Array.isArray(value.nodes)) {
    addIssue(errors, "invalid-graph", "nodes", "must be an array");
  } else {
    value.nodes.forEach((node, index) => {
      const summary = validateNode(errors, node, index, registry);
      if (!summary.id) return;
      if (allIds.has(summary.id)) {
        addIssue(errors, "duplicate-id", `nodes[${index}].id`, `duplicate id ${summary.id}`);
      }
      allIds.add(summary.id);
      nodeIds.add(summary.id);
      if (summary.type) nodeTypes.set(summary.id, summary.type);
    });
  }

  if (!Array.isArray(value.edges)) {
    addIssue(errors, "invalid-graph", "edges", "must be an array");
  } else {
    value.edges.forEach((edge, index) => {
      const { edge: edgeRecord, definition } = validateEdgeShape(errors, edge, index, registry);
      if (!edgeRecord) return;
      if (typeof edgeRecord.id === "string") {
        if (allIds.has(edgeRecord.id)) {
          addIssue(errors, "duplicate-id", `edges[${index}].id`, `duplicate id ${edgeRecord.id}`);
        }
        allIds.add(edgeRecord.id);
      }
      validateEndpointConstraints(errors, edgeRecord, definition, index, nodeTypes);
    });
  }

  validateView(errors, value.view, nodeIds);

  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], graph: value as unknown as CanonicalGraphDocument };
}

export function assertGraphDocument(
  value: unknown,
  registry: TypeRegistry = defaultTypeRegistry
): asserts value is CanonicalGraphDocument {
  const result = validateGraphDocument(value, registry);
  if (!result.valid) throw new GraphValidationError(result.errors);
}

export function cloneGraphDocument(graph: CanonicalGraphDocument): CanonicalGraphDocument {
  return deepClone(graph);
}

function documentLabel(document: QuasarDocument): string {
  const fullName = document.data.full_name;
  const name = document.data.name;
  if (typeof document.title === "string" && document.title.trim()) return document.title;
  if (typeof fullName === "string" && fullName.trim()) return fullName;
  if (typeof name === "string" && name.trim()) return name;
  return document._id;
}

function relationEndpoint(document: QuasarDocument, primary: string, fallback: string): string {
  const value = document.data[primary] ?? document.data[fallback];
  return typeof value === "string" ? value : "";
}

export function graphDocumentFromDocuments(
  documents: readonly QuasarDocument[],
  options: GraphFromDocumentsOptions
): CanonicalGraphDocument {
  const createdAt = timestamp(options.timestamp);
  const nodes = documents
    .filter((document) => document.dtype !== "relation")
    .map((document) =>
      createGraphNode({
        id: document._id,
        type: document.dtype,
        label: documentLabel(document),
        properties: deepClone(document.data),
        ...(options.positions?.[document._id]
          ? { position: deepClone(options.positions[document._id]) }
          : {}),
        createdAt: isTimestamp(document.date_added) ? document.date_added : createdAt,
        updatedAt: isTimestamp(document.date_updated) ? document.date_updated : createdAt,
        extensions: { starintelDocument: deepClone(document) }
      })
    );
  const edges = documents
    .filter((document) => document.dtype === "relation")
    .map((document) => {
      const predicate = document.data.predicate;
      return createGraphEdge({
        id: document._id,
        type: typeof predicate === "string" && predicate.trim() ? predicate : "relation",
        source: relationEndpoint(document, "subject", "source"),
        target: relationEndpoint(document, "object", "target"),
        directed: document.data.directed !== false,
        label: typeof document.title === "string" ? document.title : undefined,
        properties: deepClone(document.data),
        createdAt: isTimestamp(document.date_added) ? document.date_added : createdAt,
        updatedAt: isTimestamp(document.date_updated) ? document.date_updated : createdAt,
        extensions: { starintelDocument: deepClone(document) }
      });
    });

  return createGraphDocument({
    id: options.id,
    name: options.name,
    description: options.description,
    timestamp: createdAt,
    typeLibraryRefs: options.typeLibraryRefs ?? ["starintel:0.9.0"],
    nodes,
    edges,
    viewport: options.viewport ?? null,
    layout: options.layout ?? "preset",
    selectedIds: options.selectedIds ?? [],
    metadataExtensions: { source: "starintel" },
    extensions: options.extensions
  });
}
