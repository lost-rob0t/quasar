import { schema } from "starintel_doc";

const DTYPE_LABELS = {
  person: "Person",
  org: "Organization",
  event: "Event",
  location: "Location",
  entity: "Entity",
  document: "Document",
  source: "Source",
  concept: "Concept",
  relation: "Relation",
  target: "Target"
};

const FIELD_LABELS = {
  fname: "First Name",
  mname: "Middle Name",
  lname: "Last Name",
  full_name: "Display Name",
  dob: "Date of Birth",
  org_type: "Organization Type",
  target_type: "Target Type",
  event_kind: "Event Type",
  start_at: "Start Date",
  end_at: "End Date",
  date_added: "Date Added",
  date_updated: "Date Updated",
  published_at: "Published At",
  retrieved_at: "Retrieved At",
  publisher_id: "Publisher ID",
  source_type_id: "Source Type ID",
  target_id: "Target ID",
  url: "URL",
  uri: "URI",
  asn: "ASN",
  ip: "IP"
};

// This is display priority only. Every candidate is still loaded from the active schema.
const ESSENTIAL_FIELD_PRIORITY = {
  person: ["fname", "mname", "lname", "full_name", "aliases", "description"],
  org: ["name", "legal_name", "aliases", "org_type", "description", "website"],
  target: ["target", "target_type", "status", "description", "actor"],
  relation: [
    "subject",
    "source",
    "predicate",
    "object",
    "target",
    "start_at",
    "end_at",
    "description",
    "sources"
  ],
  event: ["name", "event_kind", "start_at", "end_at", "status", "description"],
  location: ["name", "location_type", "address", "city", "state", "country"],
  entity: ["name", "etype", "description", "country", "website", "status"],
  document: [
    "display_label",
    "document_kind",
    "published_at",
    "publisher_id",
    "format",
    "description"
  ],
  source: ["name", "url", "source_type_id", "publisher", "published_at", "retrieved_at"],
  concept: ["term", "preferred_label", "definition", "domain", "vocabulary", "namespace"]
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveReference(fieldSchema = {}, rootSchema = schema) {
  if (!fieldSchema.$ref?.startsWith("#/")) return fieldSchema;
  const resolved = fieldSchema.$ref
    .slice(2)
    .split("/")
    .reduce(
      (current, segment) => current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
      rootSchema
    );
  return resolved
    ? {
        ...clone(resolved),
        ...Object.fromEntries(Object.entries(fieldSchema).filter(([key]) => key !== "$ref"))
      }
    : fieldSchema;
}

function variants(fieldSchema = {}) {
  return fieldSchema.anyOf || fieldSchema.oneOf || [];
}

export function isNullableSchema(fieldSchema = {}) {
  return (
    fieldSchema.type === "null" ||
    (Array.isArray(fieldSchema.type) && fieldSchema.type.includes("null")) ||
    variants(fieldSchema).some(
      (candidate) =>
        candidate.type === "null" ||
        (Array.isArray(candidate.type) && candidate.type.includes("null"))
    )
  );
}

export function effectiveFieldSchema(fieldSchema = {}, rootSchema = schema) {
  const dereferenced = resolveReference(fieldSchema, rootSchema);
  const options = variants(dereferenced);
  if (!options.length) {
    if (!Array.isArray(dereferenced.type)) return dereferenced;
    return {
      ...dereferenced,
      type: dereferenced.type.find((type) => type !== "null") || dereferenced.type[0]
    };
  }
  const selected =
    options.find((candidate) => candidate.type && candidate.type !== "null") ||
    options.find((candidate) => candidate.$ref) ||
    options[0] ||
    dereferenced;
  const resolved = resolveReference(
    {
      ...selected,
      title: dereferenced.title || selected.title,
      description: dereferenced.description || selected.description
    },
    rootSchema
  );
  if (!Array.isArray(resolved.type)) return resolved;
  return { ...resolved, type: resolved.type.find((type) => type !== "null") || resolved.type[0] };
}

export function humanizeSchemaField(name) {
  const key = String(name);
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return key
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b(id|url|uri|ip|asn)\b/gi, (value) => value.toUpperCase())
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function dtypeLabel(dtype) {
  return DTYPE_LABELS[dtype] || humanizeSchemaField(dtype);
}

export function dataSchemaForDtype(dtype, activeSchema = schema) {
  const variant = (activeSchema.allOf || []).find(
    (candidate) =>
      candidate.if?.properties?.dtype?.const === dtype ||
      candidate.if?.properties?.object_type?.const === dtype
  );
  return clone(
    variant?.then?.properties?.data ||
      variant?.then?.properties?.attributes || { type: "object", properties: {}, required: [] }
  );
}

export function dataFieldsForDtype(dtype, activeSchema = schema) {
  return Object.keys(dataSchemaForDtype(dtype, activeSchema).properties || {});
}

export function schemaType(fieldSchema = {}) {
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.enum) return "enum";
  if (resolved.format === "date") return "date";
  if (resolved.format === "date-time") return "datetime";
  if (resolved.format === "uri" || resolved.format === "url") return "url";
  if (resolved["x-starintel-reference"] === "relation") return "relation reference";
  if (resolved["x-starintel-reference"] || resolved.$ref?.toLowerCase().includes("reference"))
    return "document reference";
  if (resolved["x-starintel-predicate"] || fieldSchema["x-starintel-predicate"]) return "predicate";
  if (resolved.type === "array") {
    const item = effectiveFieldSchema(resolved.items || {});
    if (item.type === "string") return "string[]";
    return `${schemaType(resolved.items || {})}[]`;
  }
  return resolved.type || "value";
}

export function fieldTypeHint(fieldSchema = {}, required = false) {
  const resolved = effectiveFieldSchema(fieldSchema);
  const parts = [schemaType(fieldSchema)];
  if (resolved.type === "array") parts.push("multiple values");
  else if (!required) parts.push("optional");
  if (isNullableSchema(fieldSchema)) parts.push("nullable");
  return [...new Set(parts)].join(" · ");
}

export function fieldDescriptor(name, fieldSchema = {}, required = false) {
  const resolved = effectiveFieldSchema(fieldSchema);
  return {
    name,
    label: fieldSchema.title || resolved.title || humanizeSchemaField(name),
    schema: fieldSchema,
    resolvedSchema: resolved,
    type: schemaType(fieldSchema),
    required,
    nullable: isNullableSchema(fieldSchema),
    enumValues: resolved.enum || fieldSchema.enum || [],
    nestedSchema: resolved.properties ? resolved : null,
    defaultValue: "const" in fieldSchema ? fieldSchema.const : fieldSchema.default,
    essentialPriority: Number(
      fieldSchema["x-starintel-essential-priority"] ??
        resolved["x-starintel-essential-priority"] ??
        Number.POSITIVE_INFINITY
    ),
    objectReferenceConstraints:
      fieldSchema["x-starintel-object-types"] || resolved["x-starintel-object-types"] || [],
    relationConstraints:
      fieldSchema["x-starintel-relation-constraints"] ||
      resolved["x-starintel-relation-constraints"] ||
      null,
    helpText: fieldSchema.description || resolved.description || ""
  };
}

export function dataFieldDescriptorsForDtype(dtype, activeSchema = schema) {
  const dataSchema = dataSchemaForDtype(dtype, activeSchema);
  const required = new Set(dataSchema.required || []);
  return Object.entries(dataSchema.properties || {}).map(([name, fieldSchema]) =>
    fieldDescriptor(name, fieldSchema, required.has(name))
  );
}

export function essentialDataFieldsForDtype(dtype, limit = 6, activeSchema = schema) {
  const descriptors = dataFieldDescriptorsForDtype(dtype, activeSchema);
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const explicit = descriptors
    .filter((descriptor) => Number.isFinite(descriptor.essentialPriority))
    .sort((left, right) => left.essentialPriority - right.essentialPriority)
    .map((descriptor) => descriptor.name);
  const preferred = (ESSENTIAL_FIELD_PRIORITY[dtype] || []).filter((name) => byName.has(name));
  const required = descriptors
    .filter((descriptor) => descriptor.required)
    .map((descriptor) => descriptor.name);
  const simple = descriptors
    .filter(
      (descriptor) =>
        !["object", "value"].includes(descriptor.type) && !descriptor.type.endsWith("[]")
    )
    .map((descriptor) => descriptor.name);
  return [...new Set([...explicit, ...preferred, ...required, ...simple])].slice(0, limit);
}

export function formatSchemaValue(value, fieldSchema) {
  if (value == null) return "";
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.type === "object" || resolved.type === "array" || typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export function parseSchemaField(name, value, fieldSchema, parseJson) {
  if (value === "" || value == null) return undefined;
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.type === "boolean") return value === true || value === "true";
  if (resolved.type === "integer") {
    const number = Number(value);
    if (!Number.isInteger(number))
      throw new Error(`${humanizeSchemaField(name)} must be an integer`);
    return number;
  }
  if (resolved.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${humanizeSchemaField(name)} must be a number`);
    return number;
  }
  if (resolved.type === "object" || resolved.type === "array" || !resolved.type) {
    return parseJson(value, humanizeSchemaField(name), resolved.type === "array" ? [] : {});
  }
  return value;
}

export function emptySchemaValue(fieldSchema = {}, options = {}) {
  const { warnings = [], path = "field", rootSchema = schema, preserveNullable = true } = options;
  const dereferenced = resolveReference(fieldSchema, rootSchema);
  if (Object.hasOwn(dereferenced, "const")) return clone(dereferenced.const);
  if (preserveNullable && isNullableSchema(dereferenced)) return null;
  const resolved = effectiveFieldSchema(dereferenced, rootSchema);
  if (Object.hasOwn(resolved, "const")) return clone(resolved.const);
  if (resolved.type === "string") return "";
  if (resolved.type === "array") return [];
  if (resolved.type === "boolean") return false;
  if (resolved.type === "integer" || resolved.type === "number") return 0;
  if (resolved.type === "object") {
    return Object.fromEntries(
      Object.entries(resolved.properties || {}).map(([name, child]) => [
        name,
        emptySchemaValue(child, { warnings, path: `${path}.${name}`, rootSchema, preserveNullable })
      ])
    );
  }
  warnings.push(`Unsupported schema type at ${path}; generated null.`);
  return null;
}

function topLevelSchemaForDtype(dtype, activeSchema) {
  const properties = clone(activeSchema.properties || {});
  const required = new Set(activeSchema.required || []);
  const variant = (activeSchema.allOf || []).find(
    (candidate) =>
      candidate.if?.properties?.dtype?.const === dtype ||
      candidate.if?.properties?.object_type?.const === dtype
  );
  Object.assign(properties, clone(variant?.then?.properties || {}));
  for (const name of variant?.then?.required || []) required.add(name);
  return { properties, required: [...required] };
}

export function generateEmptyDocument(dtype, options = {}) {
  const activeSchema = options.activeSchema || schema;
  const warnings = [];
  const documentSchema = topLevelSchemaForDtype(dtype, activeSchema);
  const document = Object.fromEntries(
    Object.entries(documentSchema.properties).map(([name, fieldSchema]) => {
      if (name === "dtype" || name === "object_type") return [name, dtype];
      if (name === "data" || name === "attributes") {
        const dataSchema = dataSchemaForDtype(dtype, activeSchema);
        return [
          name,
          emptySchemaValue(dataSchema, { warnings, path: name, rootSchema: activeSchema })
        ];
      }
      return [
        name,
        emptySchemaValue(fieldSchema, { warnings, path: name, rootSchema: activeSchema })
      ];
    })
  );
  for (const [name, value] of Object.entries(options.overrides || {}))
    document[name] = clone(value);
  return { document, warnings };
}
