import { assertDocument } from "starintel_doc";
import { operation } from "./operations";

export const AGENT_GRAPH_OPERATIONS = Object.freeze([
  "create_node",
  "update_node",
  "delete_node",
  "create_relation",
  "update_relation",
  "delete_relation",
  "merge_nodes",
  "split_node",
  "link_cross_dataset",
  "move_node",
  "create_graph",
  "add_to_graph",
  "remove_from_graph",
  "apply_layout",
  "focus_selection",
  "fit_graph",
  "create_group",
  "collapse_group",
  "expand_group"
]);

const OPERATION_SET = new Set(AGENT_GRAPH_OPERATIONS);
const DESTRUCTIVE = new Set([
  "delete_node",
  "delete_relation",
  "merge_nodes",
  "split_node",
  "remove_from_graph"
]);

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function provenance(document, context) {
  const next = clone(document);
  delete next._rev;
  next.extensions = {
    ...(next.extensions || {}),
    "quasar.agent": {
      ...next.extensions?.["quasar.agent"],
      agent_id: context.agentId,
      run_id: context.runId,
      operation: context.operation,
      recorded_at: new Date().toISOString()
    }
  };
  return assertDocument(next);
}

function requireDocument(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} document is required`);
  return value;
}

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required`);
  return id;
}

function replaceEndpoint(value, replacements) {
  if (typeof value === "string") return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => replaceEndpoint(item, replacements));
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  for (const key of ["id", "entity_id", "document_id"]) {
    if (next[key] && replacements.has(next[key])) next[key] = replacements.get(next[key]);
  }
  return next;
}

export function previewAgentGraphOperations(currentDocuments, rawOperations, context) {
  if (!Array.isArray(rawOperations) || !rawOperations.length)
    throw new TypeError("Graph operations are required");
  if (rawOperations.length > 100) throw new RangeError("Graph operation limit is 100");
  const documents = new Map(currentDocuments.map((document) => [document._id, document]));
  const commands = [];
  const workspace = [];
  const changes = [];
  let destructive = false;

  for (const [index, input] of rawOperations.entries()) {
    const op = String(input?.op || "");
    if (!OPERATION_SET.has(op))
      throw new TypeError(`Unsupported graph operation: ${op || `<missing at ${index}>`}`);
    destructive ||= DESTRUCTIVE.has(op);
    const provenanceContext = { ...context, operation: op };

    if (
      [
        "create_node",
        "create_relation",
        "update_node",
        "update_relation",
        "link_cross_dataset"
      ].includes(op)
    ) {
      const document = provenance(requireDocument(input.document, op), provenanceContext);
      const existing = documents.get(document._id);
      if (op.startsWith("create_") && existing)
        throw new Error(`Document already exists: ${document._id}`);
      if (op.startsWith("update_") && !existing)
        throw new Error(`Document not found: ${document._id}`);
      if (
        ["create_relation", "update_relation", "link_cross_dataset"].includes(op) &&
        document.dtype !== "relation"
      ) {
        throw new TypeError(`${op} requires a relation document`);
      }
      commands.push(operation.save(document));
      documents.set(document._id, document);
      changes.push({
        action: existing ? "update" : "create",
        id: document._id,
        objectType: document.dtype,
        document
      });
      continue;
    }

    if (["delete_node", "delete_relation"].includes(op)) {
      const targetId = requireId(input.id, `${op} ID`);
      const existing = documents.get(targetId);
      if (!existing) throw new Error(`Document not found: ${targetId}`);
      if (op === "delete_relation" && existing.dtype !== "relation")
        throw new Error(`${targetId} is not a relation`);
      commands.push(operation.remove(targetId));
      documents.delete(targetId);
      changes.push({ action: "delete", id: targetId, objectType: existing.dtype });
      continue;
    }

    if (op === "merge_nodes") {
      const primaryId = requireId(input.primaryId, "Primary node ID");
      const mergeIds = [...new Set((input.mergeIds || []).map(String))].filter(
        (id) => id !== primaryId
      );
      if (!documents.has(primaryId) || !mergeIds.length)
        throw new Error("Merge requires an existing primary node and at least one other node");
      for (const mergeId of mergeIds)
        if (!documents.has(mergeId)) throw new Error(`Merge node not found: ${mergeId}`);
      const replacements = new Map(mergeIds.map((id) => [id, primaryId]));
      for (const document of documents.values()) {
        if (document.dtype !== "relation") continue;
        const data = document.data || {};
        const nextData = {
          ...data,
          subject: replaceEndpoint(data.subject, replacements),
          source: replaceEndpoint(data.source, replacements),
          object: replaceEndpoint(data.object, replacements),
          target: replaceEndpoint(data.target, replacements)
        };
        if (JSON.stringify(nextData) !== JSON.stringify(data)) {
          const updated = provenance({ ...document, data: nextData }, provenanceContext);
          commands.push(operation.save(updated));
          changes.push({
            action: "update",
            id: updated._id,
            objectType: "relation",
            document: updated
          });
        }
      }
      for (const mergeId of mergeIds) {
        commands.push(operation.remove(mergeId));
        changes.push({ action: "delete", id: mergeId, objectType: documents.get(mergeId).dtype });
      }
      workspace.push({ op: "remove_from_graph", ids: mergeIds });
      continue;
    }

    if (op === "split_node") {
      const sourceId = requireId(input.id, "Source node ID");
      if (!documents.has(sourceId)) throw new Error(`Document not found: ${sourceId}`);
      const parts = (input.documents || []).map((document) =>
        provenance(document, provenanceContext)
      );
      if (parts.length < 2) throw new Error("Split requires at least two replacement documents");
      for (const document of parts) {
        if (documents.has(document._id))
          throw new Error(`Split document already exists: ${document._id}`);
        commands.push(operation.save(document));
        changes.push({ action: "create", id: document._id, objectType: document.dtype, document });
      }
      if (input.removeSource !== false) {
        commands.push(operation.remove(sourceId));
        changes.push({ action: "delete", id: sourceId, objectType: documents.get(sourceId).dtype });
      }
      workspace.push({ op: "add_to_graph", ids: parts.map((document) => document._id) });
      continue;
    }

    workspace.push(clone(input));
    changes.push({
      action: op,
      id: input.id || input.graphId || input.groupId || null,
      details: clone(input)
    });
  }

  return {
    version: 1,
    commands,
    workspace,
    changes,
    destructive,
    requiresApproval: destructive,
    summary: {
      operations: rawOperations.length,
      documentMutations: commands.length,
      workspaceMutations: workspace.length
    }
  };
}

export async function applyAgentGraphPlan(plan, environment, { approved = false } = {}) {
  if (plan.requiresApproval && !approved) {
    const error = new Error("Destructive graph operations require approval");
    error.code = "approval_required";
    throw error;
  }
  if (plan.commands.length) {
    await environment.execute(
      operation.batch(plan.commands, "Agent graph operations"),
      "Agent graph operations"
    );
  }
  for (const workspaceOperation of plan.workspace) {
    await environment.applyWorkspaceOperation(workspaceOperation);
  }
  return {
    applied: plan.changes.length,
    affected: plan.changes,
    undoable: plan.commands.length > 0,
    transaction: plan.commands.length > 0 ? "Agent graph operations" : null
  };
}
