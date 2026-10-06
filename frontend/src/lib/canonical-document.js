import { parseJson, workflowMappings } from "starintel_doc";
// StarLang-generated 0.10.1 boundary. Historical UI models are adapted explicitly.
import { assertDocument, createDocument, documentTypes, schema, SPEC_VERSION } from "starintel_doc";

export { assertDocument, createDocument, schema, SPEC_VERSION };
export function documentSchema(dtype) {
  const name = documentTypes[dtype];
  if (!name) throw new TypeError(`Unknown canonical document type: ${dtype}`);
  return schema.$defs[name];
}

const camel = (name) => name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const envelopeMetadata = new Set([
  "schema_version",
  "schema_revision",
  "schema_uri",
  "profile",
  "profile_version"
]);
const preservedMetadata = new Set([
  "version",
  "title",
  "summary",
  "description",
  "evidence",
  "assessment",
  "attachments",
  "geospatial",
  "handling",
  "identifiers",
  "keywords",
  "lineage",
  "schema_org",
  "quality",
  "related_ids",
  "status",
  "temporal",
  "verification",
  "workflow",
  "object_marking_ids",
  "revoked",
  "created_by_ref",
  "modified_by_ref"
]);
const reference = (value) =>
  typeof value === "string" ? { schema: "org.starintel/core@1/document", id: value } : value;
function resolvedField(field, value) {
  if (field?.$ref) return resolvedField(schema.$defs[field.$ref.split("/").at(-1)], value);
  if (field?.anyOf)
    return resolvedField(
      field.anyOf.find((item) => (value === null ? item.type === "null" : item.type !== "null")) ||
        field.anyOf[0],
      value
    );
  return field;
}
function canonicalValue(value, field, reverse = false) {
  if (field?.$ref?.endsWith("/StarReference")) return reverse ? value : reference(value);
  field = resolvedField(field, value);
  if (value === null) return null;
  if (field?.type === "string" && field.pattern?.includes("[0-9]")) {
    if (!reverse && typeof value === "number" && Number.isFinite(value)) return String(value);
    if (reverse && typeof value === "string") {
      const number = Number(value);
      // Numeric legacy models cannot retain arbitrary-precision decimals.
      if (
        !Number.isFinite(number) ||
        String(number) !== value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
      ) {
        return value;
      }
      return number;
    }
  }
  if (field?.type === "array" && Array.isArray(value))
    return value.map((item) => canonicalValue(item, field.items, reverse));
  if (
    field?.type === "object" &&
    field.properties &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const names = new Set();
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => {
        const canonical = reverse ? name : camel(name);
        if (names.has(canonical))
          throw new TypeError(`Conflicting nested historical field ${name}`);
        names.add(canonical);
        const key = reverse
          ? name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
          : canonical;
        return [key, canonicalValue(child, field.properties[canonical], reverse)];
      })
    );
  }
  return value;
}
const aliases = { _id: "id", _rev: "rev", date_added: "createdAt", date_updated: "updatedAt" };

// Migration is deliberately opt-in and fail-closed. Never stamp a legacy object
// with a new version or silently drop a field whose semantics are unknown.
export function migrateLegacy090Document(input) {
  if (input?.schemaVersion) return assertDocument(input);
  if (input?.schema_version !== "0.9.0")
    throw new TypeError("Expected explicit historical 0.9.0 document");
  const definition = documentSchema(input.dtype);
  const output = { dtype: input.dtype, schemaVersion: SPEC_VERSION };
  const mapping = workflowMappings.contracts[input.dtype]?.fields;
  const domainFields = new Set(Object.values(mapping || {}));
  const historical = {};
  const historicalData = {};
  const write = (name, value, path) => {
    const relationAliases =
      input.dtype === "relation"
        ? { subject: "source", object: "destination", target: "destination", directed: "direction" }
        : {};
    const inPayload = path.startsWith("data.");
    if (mapping && inPayload && !Object.hasOwn(mapping, name))
      throw new TypeError(`Unmapped historical field ${path}; manual migration required`);
    const canonical =
      inPayload && mapping ? mapping[name] : relationAliases[name] || aliases[name] || camel(name);
    if (input.dtype === "dataset-manifest" && inPayload && name === "counts_by_dtype")
      value = Object.entries(value).map(([key, count]) => ({ key, value: count }));
    if (canonical === "sources" && Array.isArray(value)) value = value.map(reference);
    if (input.dtype === "relation" && ["source", "destination"].includes(canonical))
      value = reference(value);
    if (input.dtype === "relation" && name === "directed")
      value = value === false ? "symmetric" : "directed";
    if (!Object.hasOwn(definition.properties, canonical)) {
      throw new TypeError(`Unmapped historical field ${path}; manual migration required`);
    }
    value = canonicalValue(value, definition.properties[canonical]);
    if (
      Object.hasOwn(output, canonical) &&
      JSON.stringify(output[canonical]) !== JSON.stringify(value)
    ) {
      throw new TypeError(`Conflicting historical field ${path} maps to ${canonical}`);
    }
    output[canonical] = value;
  };
  for (const [name, value] of Object.entries(input)) {
    if (envelopeMetadata.has(name) || name === "data") continue;
    if (
      preservedMetadata.has(name) &&
      (!Object.hasOwn(definition.properties, aliases[name] || camel(name)) ||
        domainFields.has(aliases[name] || camel(name)))
    ) {
      historical[name] = value;
      continue;
    }
    if (name === "date_added" || name === "date_updated") {
      const milliseconds = Date.parse(value);
      if (!Number.isFinite(milliseconds)) {
        throw new TypeError(`Historical ${name} must represent a valid timestamp`);
      }
      if (milliseconds % 1000) historical[name] = value;
      write(name, Math.floor(milliseconds / 1000), name);
    } else if (
      name === "extensions" &&
      value?.quasarCanonicalMetadata?.format === "quasar.canonical-metadata.v1"
    ) {
      const { quasarCanonicalMetadata, ...rest } = value;
      for (const [key, metadata] of Object.entries(quasarCanonicalMetadata.fields || {})) {
        if (!Object.hasOwn(schema.$defs.Document.properties, key))
          throw new TypeError(`Invalid canonical metadata key ${key}`);
        write(key, metadata, key);
      }
      if (Object.hasOwn(quasarCanonicalMetadata, "originalValue"))
        rest.quasarCanonicalMetadata = quasarCanonicalMetadata.originalValue;
      if (Object.keys(rest).length) write(name, rest, name);
    } else write(name, value, name);
  }
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
    throw new TypeError("Historical data must be an object");
  }
  for (const [name, value] of Object.entries(input.data)) {
    if (input.dtype === "person" && name === "external_ids" && Array.isArray(value)) {
      if (value.length)
        throw new TypeError(
          "Person external_ids requires an identifier-document bundle; atomic bundle application is unavailable in this editor"
        );
      // An empty historical identifier list carries no identifiers to migrate.
      historicalData[name] = [];
      continue;
    }
    // The historical active flag has no exact validity-interval equivalent.
    if (input.dtype === "relation" && name === "active") historicalData[name] = value;
    else write(name, value, `data.${name}`);
  }
  if (Object.keys(historicalData).length) historical.data = historicalData;
  if (Object.keys(historical).length) {
    if (Object.hasOwn(output.extensions || {}, "quasarLegacy090")) {
      throw new TypeError("Reserved compatibility extension quasarLegacy090 would be overwritten");
    }
    output.extensions = { ...output.extensions, quasarLegacy090: historical };
  }
  return assertDocument(output);
}

export function toCanonicalDocument(input, { allowLegacy090 = false } = {}) {
  if (input?.schemaVersion === SPEC_VERSION) return assertDocument(input);
  if (allowLegacy090) return migrateLegacy090Document(input);
  throw new TypeError(
    "Canonical StarIntel 0.10.1 document required; select legacy migration explicitly"
  );
}

// PouchDB metadata belongs to the storage adapter, never the StarIntel wire.
export function toPouchDocument(input) {
  const document = assertDocument(input);
  const { rev, ...body } = document;
  return { ...body, _id: document.id, ...(rev ? { _rev: rev } : {}) };
}
export function fromPouchDocument(input) {
  const { _id, _rev, ...body } = input;
  if (_id !== body.id) throw new TypeError("PouchDB ID disagrees with canonical document ID");
  return assertDocument({ ...body, ...(_rev ? { rev: _rev } : {}) });
}

// Explicit presentation adapter for historical graph/actor consumers. This value
// is never a canonical wire document: convert it before persistence or transport.
export function toLegacyUiDocument(input) {
  const document = assertDocument(input);
  const { quasarLegacy090 = {}, ...extensions } = document.extensions || {};
  const result = {
    ...quasarLegacy090,
    _id: document.id,
    dataset: document.dataset,
    dtype: document.dtype,
    schema_version: "0.9.0",
    data: { ...(quasarLegacy090.data || {}) },
    extensions
  };
  const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const mapping = workflowMappings.contracts[document.dtype]?.fields;
  const inverse = Object.fromEntries(
    Object.entries(mapping || {}).map(([key, value]) => [value, key])
  );
  const top = new Set([
    "sources",
    "tags",
    "aliases",
    "labels",
    "language",
    "notes",
    "provenance",
    "deleted"
  ]);
  for (const [name, value] of Object.entries(document)) {
    if (["id", "dataset", "dtype", "schemaVersion", "extensions"].includes(name)) continue;
    if (Object.hasOwn(inverse, name)) {
      result.data[inverse[name]] =
        document.dtype === "dataset-manifest" && name === "countsByDtype"
          ? Object.fromEntries(value.map((entry) => [entry.key, entry.value]))
          : canonicalValue(value, documentSchema(document.dtype).properties[name], true);
    } else if (name === "rev") result._rev = value;
    else if (name === "createdAt" || name === "updatedAt") {
      const field = name === "createdAt" ? "date_added" : "date_updated";
      if (!Object.hasOwn(result, field) || Math.floor(Date.parse(result[field]) / 1000) !== value)
        result[field] = new Date(value * 1000).toISOString();
    } else if (top.has(name)) result[name] = value;
    else if (document.dtype === "relation" && name === "source") result.data.subject = value;
    else if (document.dtype === "relation" && name === "destination") result.data.object = value;
    else if (document.dtype === "relation" && name === "direction") {
      // Preserve inverse/unknown exactly; the legacy graph only renders a hint.
      result.data.direction = value;
    } else if (mapping && Object.hasOwn(schema.$defs.Document.properties, name)) {
      if (
        !Object.hasOwn(result.extensions, "quasarCanonicalMetadata") ||
        result.extensions.quasarCanonicalMetadata?.format !== "quasar.canonical-metadata.v1" ||
        result.extensions.quasarCanonicalMetadata === document.extensions?.quasarCanonicalMetadata
      ) {
        result.extensions.quasarCanonicalMetadata = {
          format: "quasar.canonical-metadata.v1",
          fields: {},
          ...(Object.hasOwn(document.extensions || {}, "quasarCanonicalMetadata")
            ? { originalValue: document.extensions.quasarCanonicalMetadata }
            : {})
        };
      }
      result.extensions.quasarCanonicalMetadata.fields[name] = value;
    } else result.data[snake(name)] = value;
  }
  if (
    document.dtype === "target" &&
    document.targetType === "tip" &&
    extensions.auto_dig?.local_tip_id
  ) {
    result.title = `Tip: ${extensions.auto_dig.title}`;
    result.summary = extensions.auto_dig.summary;
  }
  return result;
}

export function parseBrowserDocumentJson(text) {
  const parsed = parseJson(text);
  const inspect = (value) => {
    if (Object.is(value, -0))
      throw new TypeError("Browser storage cannot preserve exact JSON negative zero");
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(
        "Browser storage cannot preserve this exact JSON number; use the canonical CLI instead of rounding it"
      );
    }
    for (const child of Object.values(value)) inspect(child);
  };
  inspect(parsed);
  return parsed;
}
