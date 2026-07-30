import { assertDocument } from "starintel_doc";
import { actorConfigurationStatus } from "./actor-configuration";

export const ACTOR_TRANSFORM_OPERATIONS = Object.freeze([
  "create_document",
  "update_document",
  "upsert_document",
  "remove_document",
  "create_relation",
  "remove_relation"
]);

const MAX_ACTOR_OPERATIONS = 2_048;
const OPERATION_SET = new Set(ACTOR_TRANSFORM_OPERATIONS);
const corpusCommand = Object.freeze({
  save(document) {
    return { type: "save-document", document };
  },
  remove(id) {
    return { type: "remove-document", id };
  },
  batch(operations, label) {
    return { type: "batch", label, operations };
  }
});

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizeDocument(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Actor operation ${index} document must be an object`);
  }
  const document = cloneValue(value);
  delete document._rev;
  return assertDocument(document);
}

function normalizeId(value, index) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`Actor operation ${index} id is required`);
  return id;
}

function normalizeOperation(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Actor operation ${index} must be an object`);
  }
  const op = String(value.op || "").trim();
  if (!OPERATION_SET.has(op))
    throw new TypeError(`Unsupported actor operation: ${op || "<missing>"}`);

  if (["create_document", "update_document", "upsert_document", "create_relation"].includes(op)) {
    const document = normalizeDocument(value.document, index);
    if (op === "create_relation" && document.dtype !== "relation") {
      throw new TypeError(`Actor operation ${index} create_relation requires a relation document`);
    }
    return { op, document };
  }

  return { op, id: normalizeId(value.id, index) };
}

export function normalizeActorTransformResult(result) {
  if (result === undefined || result === null) result = {};
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("Actor result must be an object");
  }

  const rawDocuments = result.documents === undefined ? [] : result.documents;
  const rawOperations = result.operations === undefined ? [] : result.operations;
  if (!Array.isArray(rawDocuments)) throw new TypeError("Actor result documents must be an array");
  if (!Array.isArray(rawOperations))
    throw new TypeError("Actor result operations must be an array");

  const combined = [
    ...rawDocuments.map((document) => ({ op: "upsert_document", document })),
    ...rawOperations
  ];
  if (combined.length > MAX_ACTOR_OPERATIONS) {
    throw new RangeError(`Actor returned more than ${MAX_ACTOR_OPERATIONS} transform operations`);
  }

  return {
    message: String(result.message || "").trim(),
    operations: combined.map(normalizeOperation),
    legacyDocumentCount: rawDocuments.length
  };
}

export function actorWithTransformEnvelope(actor) {
  const configurationStatus = actorConfigurationStatus(actor);
  if (!configurationStatus.configured) {
    throw new Error(
      `Configure ${configurationStatus.missing.join(", ")} before running ${actor.label || actor.id}`
    );
  }
  const configuration = JSON.stringify(configurationStatus.configuration || {});

  return {
    ...actor,
    source: `(context, api) => {
      const implementation = (${actor.source});
      const configuredContext = Object.freeze({
        ...context,
        configuration: Object.freeze(${configuration})
      });
      return Promise.resolve(implementation(configuredContext, api)).then((result) => {
        if (result && Array.isArray(result.operations) && !Array.isArray(result.documents)) {
          return { ...result, documents: [] };
        }
        return result;
      });
    }`
  };
}

export function buildActorTransform(result, currentDocuments, label = "Actor transform") {
  const normalized = normalizeActorTransformResult(result);
  const documents = new Map((currentDocuments || []).map((document) => [document._id, document]));
  const commands = [];
  const savedDocuments = new Map();
  const removedIds = [];
  const counts = {
    created: 0,
    updated: 0,
    upserted: 0,
    removed: 0,
    relationsCreated: 0,
    relationsRemoved: 0
  };

  for (const transform of normalized.operations) {
    if (
      ["create_document", "update_document", "upsert_document", "create_relation"].includes(
        transform.op
      )
    ) {
      const existing = documents.get(transform.document._id);
      if (transform.op === "create_document" && existing) {
        throw new Error(`Actor cannot create existing document: ${transform.document._id}`);
      }
      if (transform.op === "update_document" && !existing) {
        throw new Error(`Actor cannot update missing document: ${transform.document._id}`);
      }
      if (transform.op === "create_relation" && existing) {
        throw new Error(`Actor cannot create existing relation: ${transform.document._id}`);
      }

      commands.push(corpusCommand.save(transform.document));
      documents.set(transform.document._id, transform.document);
      savedDocuments.set(transform.document._id, transform.document);
      if (transform.op === "create_document") counts.created += 1;
      else if (transform.op === "update_document") counts.updated += 1;
      else if (transform.op === "create_relation") counts.relationsCreated += 1;
      else counts.upserted += 1;
      continue;
    }

    const existing = documents.get(transform.id);
    if (!existing) throw new Error(`Actor cannot remove missing document: ${transform.id}`);
    if (transform.op === "remove_relation" && existing.dtype !== "relation") {
      throw new Error(`Actor cannot remove non-relation as a relation: ${transform.id}`);
    }
    commands.push(corpusCommand.remove(transform.id));
    documents.delete(transform.id);
    savedDocuments.delete(transform.id);
    removedIds.push(transform.id);
    if (transform.op === "remove_relation") counts.relationsRemoved += 1;
    else counts.removed += 1;
  }

  const operationCount = normalized.operations.length;
  return {
    command: commands.length ? corpusCommand.batch(commands, label) : null,
    documents: [...savedDocuments.values()],
    removedIds,
    operationCount,
    counts,
    message: normalized.message || `Applied ${operationCount} actor transform operation(s).`,
    legacyDocumentCount: normalized.legacyDocumentCount
  };
}
