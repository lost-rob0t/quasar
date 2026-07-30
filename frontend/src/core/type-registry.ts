import { assertStableIdentifier } from "./identifiers";

export type PropertyValueType =
  "any" | "boolean" | "date" | "number" | "number[]" | "object" | "string" | "string[]" | "url";

export interface TypePropertyDefinition {
  key: string;
  label: string;
  valueType: PropertyValueType;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
}

export interface TypeDisplayHints {
  icon?: string;
  color?: string;
  shape?: string;
  labelProperty?: string;
}

export interface EdgeEndpointConstraint {
  sourceTypes?: readonly string[];
  targetTypes?: readonly string[];
  allowSelf?: boolean;
}

interface BaseTypeDefinition {
  id: string;
  label: string;
  properties: readonly TypePropertyDefinition[];
  display?: TypeDisplayHints;
  extensions?: Readonly<Record<string, unknown>>;
  unknown?: boolean;
}

export interface NodeTypeDefinition extends BaseTypeDefinition {
  kind: "node";
}

export interface EdgeTypeDefinition extends BaseTypeDefinition {
  kind: "edge";
  directed?: boolean;
  endpoints?: EdgeEndpointConstraint;
}

export interface TypeRegistryInput {
  nodeTypes?: readonly NodeTypeDefinition[];
  edgeTypes?: readonly EdgeTypeDefinition[];
}

export class TypeRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeRegistryError";
  }
}

function validateProperties(typeId: string, properties: readonly TypePropertyDefinition[]): void {
  const keys = new Set<string>();
  for (const property of properties) {
    assertStableIdentifier(property.key, `property key for ${typeId}`);
    if (!property.label.trim())
      throw new TypeRegistryError(`property ${property.key} on ${typeId} requires a label`);
    if (keys.has(property.key))
      throw new TypeRegistryError(`duplicate property ${property.key} on ${typeId}`);
    keys.add(property.key);
  }
}

function validateNodeType(definition: NodeTypeDefinition): void {
  assertStableIdentifier(definition.id, "node type id");
  if (!definition.label.trim())
    throw new TypeRegistryError(`node type ${definition.id} requires a label`);
  validateProperties(definition.id, definition.properties);
}

function validateEdgeType(definition: EdgeTypeDefinition): void {
  assertStableIdentifier(definition.id, "edge type id");
  if (!definition.label.trim())
    throw new TypeRegistryError(`edge type ${definition.id} requires a label`);
  validateProperties(definition.id, definition.properties);
  for (const sourceType of definition.endpoints?.sourceTypes ?? []) {
    assertStableIdentifier(sourceType, `source type for ${definition.id}`);
  }
  for (const targetType of definition.endpoints?.targetTypes ?? []) {
    assertStableIdentifier(targetType, `target type for ${definition.id}`);
  }
}

function unknownNodeType(id: string): NodeTypeDefinition {
  return Object.freeze({
    kind: "node",
    id,
    label: `Unknown node type: ${id}`,
    properties: Object.freeze([]),
    display: Object.freeze({ labelProperty: "label" }),
    extensions: Object.freeze({ requestedType: id }),
    unknown: true
  });
}

function unknownEdgeType(id: string): EdgeTypeDefinition {
  return Object.freeze({
    kind: "edge",
    id,
    label: `Unknown edge type: ${id}`,
    directed: true,
    properties: Object.freeze([]),
    endpoints: Object.freeze({ allowSelf: true }),
    extensions: Object.freeze({ requestedType: id }),
    unknown: true
  });
}

export class TypeRegistry {
  readonly #nodeTypes = new Map<string, NodeTypeDefinition>();
  readonly #edgeTypes = new Map<string, EdgeTypeDefinition>();

  constructor(input: TypeRegistryInput = {}) {
    for (const definition of input.nodeTypes ?? []) this.registerNodeType(definition);
    for (const definition of input.edgeTypes ?? []) this.registerEdgeType(definition);
  }

  registerNodeType(definition: NodeTypeDefinition): this {
    validateNodeType(definition);
    if (this.#nodeTypes.has(definition.id)) {
      throw new TypeRegistryError(`duplicate node type ${definition.id}`);
    }
    this.#nodeTypes.set(definition.id, Object.freeze({ ...definition }));
    return this;
  }

  registerEdgeType(definition: EdgeTypeDefinition): this {
    validateEdgeType(definition);
    if (this.#edgeTypes.has(definition.id)) {
      throw new TypeRegistryError(`duplicate edge type ${definition.id}`);
    }
    this.#edgeTypes.set(definition.id, Object.freeze({ ...definition }));
    return this;
  }

  getNodeType(id: string): NodeTypeDefinition | undefined {
    return this.#nodeTypes.get(id);
  }

  getEdgeType(id: string): EdgeTypeDefinition | undefined {
    return this.#edgeTypes.get(id);
  }

  resolveNodeType(id: string): NodeTypeDefinition {
    assertStableIdentifier(id, "node type id");
    return this.#nodeTypes.get(id) ?? unknownNodeType(id);
  }

  resolveEdgeType(id: string): EdgeTypeDefinition {
    assertStableIdentifier(id, "edge type id");
    return this.#edgeTypes.get(id) ?? unknownEdgeType(id);
  }

  listNodeTypes(): NodeTypeDefinition[] {
    return [...this.#nodeTypes.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listEdgeTypes(): EdgeTypeDefinition[] {
    return [...this.#edgeTypes.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function propertyValueMatches(value: unknown, valueType: PropertyValueType): boolean {
  switch (valueType) {
    case "any":
      return true;
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "number[]":
      return (
        Array.isArray(value) &&
        value.every((item) => typeof item === "number" && Number.isFinite(item))
      );
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "url":
      if (typeof value !== "string") return false;
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
  }
}

const commonNodeTypes: readonly NodeTypeDefinition[] = [
  {
    kind: "node",
    id: "concept",
    label: "Concept",
    properties: [{ key: "name", label: "Name", valueType: "string" }],
    display: { icon: "lightbulb", labelProperty: "name", shape: "ellipse" }
  },
  {
    kind: "node",
    id: "document",
    label: "Document",
    properties: [
      { key: "name", label: "Name", valueType: "string" },
      { key: "url", label: "URL", valueType: "url" }
    ],
    display: { icon: "file-text", labelProperty: "name", shape: "round-rectangle" }
  },
  {
    kind: "node",
    id: "entity",
    label: "Entity",
    properties: [{ key: "name", label: "Name", valueType: "string" }],
    display: { icon: "circle-dot", labelProperty: "name", shape: "ellipse" }
  },
  {
    kind: "node",
    id: "event",
    label: "Event",
    properties: [
      { key: "name", label: "Name", valueType: "string" },
      { key: "date", label: "Date", valueType: "date" }
    ],
    display: { icon: "calendar-days", labelProperty: "name", shape: "round-rectangle" }
  },
  {
    kind: "node",
    id: "location",
    label: "Location",
    properties: [
      { key: "name", label: "Name", valueType: "string" },
      { key: "coordinates", label: "Coordinates", valueType: "number[]" }
    ],
    display: { icon: "map-pin", labelProperty: "name", shape: "diamond" }
  },
  {
    kind: "node",
    id: "org",
    label: "Organization",
    properties: [
      { key: "name", label: "Name", valueType: "string" },
      { key: "legal_name", label: "Legal name", valueType: "string" }
    ],
    display: { icon: "building-2", labelProperty: "name", shape: "round-rectangle" }
  },
  {
    kind: "node",
    id: "person",
    label: "Person",
    properties: [
      { key: "full_name", label: "Full name", valueType: "string" },
      { key: "fname", label: "First name", valueType: "string" },
      { key: "lname", label: "Last name", valueType: "string" }
    ],
    display: { icon: "user-round", labelProperty: "full_name", shape: "ellipse" }
  },
  {
    kind: "node",
    id: "source",
    label: "Source",
    properties: [
      { key: "name", label: "Name", valueType: "string" },
      { key: "url", label: "URL", valueType: "url" }
    ],
    display: { icon: "book-open", labelProperty: "name", shape: "round-rectangle" }
  },
  {
    kind: "node",
    id: "target",
    label: "Target",
    properties: [{ key: "name", label: "Name", valueType: "string" }],
    display: { icon: "crosshair", labelProperty: "name", shape: "hexagon" }
  }
];

const commonEdgeTypes: readonly EdgeTypeDefinition[] = [
  {
    kind: "edge",
    id: "connected-to",
    label: "Connected to",
    directed: false,
    properties: [],
    endpoints: { allowSelf: false }
  },
  {
    kind: "edge",
    id: "member-of",
    label: "Member of",
    directed: true,
    properties: [],
    endpoints: { sourceTypes: ["person"], targetTypes: ["org"], allowSelf: false }
  },
  {
    kind: "edge",
    id: "participated-in",
    label: "Participated in",
    directed: true,
    properties: [],
    endpoints: { sourceTypes: ["person", "org"], targetTypes: ["event"], allowSelf: false }
  },
  {
    kind: "edge",
    id: "relation",
    label: "Relation",
    directed: true,
    properties: [],
    endpoints: { allowSelf: true }
  }
];

export function createDefaultTypeRegistry(): TypeRegistry {
  return new TypeRegistry({ nodeTypes: commonNodeTypes, edgeTypes: commonEdgeTypes });
}

export const defaultTypeRegistry = createDefaultTypeRegistry();
