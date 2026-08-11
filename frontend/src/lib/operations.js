import {
  cpDocumentCreate,
  cpDocumentDelete,
  cpDocumentUpdate,
  cpSnapshot,
  cpTransaction
} from "../control-plane/mutations";
import { validateDocumentBatch } from "./document-batch";

export const operation = Object.freeze({
  save(document) {
    return { type: "save-document", document };
  },
  remove(id) {
    return { type: "remove-document", id };
  },
  batch(operations, label = "Batch") {
    return { type: "batch", label, operations };
  }
});

async function applySave(command) {
  const snapshot = await cpSnapshot();
  const previous = snapshot.documents?.find((document) => document._id === command.document._id);
  const saved = previous
    ? await cpDocumentUpdate(command.document)
    : await cpDocumentCreate(command.document);
  return {
    result: saved,
    inverse: previous
      ? operation.save(previous)
      : operation.remove(saved.created?._id || command.document._id)
  };
}

async function applyRemove(command) {
  const snapshot = await cpSnapshot();
  const previous = snapshot.documents?.find((document) => document._id === command.id);
  if (!previous) return { result: null, inverse: null };
  await cpDocumentDelete(command.id);
  return { result: previous, inverse: operation.save(previous) };
}

async function applyBatch(command) {
  const snapshot = await cpSnapshot();
  const known = new Map((snapshot.documents || []).map((document) => [document._id, document]));
  const inverses = [];
  const commands = (command.operations || []).map((child) => {
    if (child.type === "save-document") {
      const previous = known.get(child.document._id);
      inverses.unshift(previous ? operation.save(previous) : operation.remove(child.document._id));
      known.set(child.document._id, child.document);
      return {
        type: previous ? "document.update" : "document.create",
        payload: child.document
      };
    }
    if (child.type === "remove-document") {
      const previous = known.get(child.id);
      if (previous) inverses.unshift(operation.save(previous));
      known.delete(child.id);
      return { type: "document.delete", payload: { id: child.id } };
    }
    throw new TypeError(`Unknown batch operation type: ${child.type}`);
  });
  const result = commands.length ? await cpTransaction(commands) : { results: [] };
  return {
    result,
    inverse: inverses.length ? operation.batch(inverses, `Undo ${command.label || "batch"}`) : null
  };
}

export async function applyOperation(command) {
  if (!command || typeof command !== "object") throw new TypeError("Operation must be an object");
  if (command.type === "save-document") return applySave(command);
  if (command.type === "remove-document") return applyRemove(command);
  if (command.type === "batch") return applyBatch(command);
  throw new TypeError(`Unknown operation type: ${command.type}`);
}

export async function saveDocumentBatch(
  documents,
  label = "Save documents",
  { replace = true, atomic = true, origins = [] } = {}
) {
  const preflight = validateDocumentBatch(documents, { origins });
  if (atomic && preflight.errors.length) {
    const report = { saved: [], skipped: [], errors: preflight.errors, atomic, rolledBack: 0 };
    const error = new Error(`Batch rejected ${report.errors.length} document(s)`);
    error.report = report;
    throw error;
  }

  const snapshot = await cpSnapshot();
  const previous = new Map((snapshot.documents || []).map((document) => [document._id, document]));
  const savedDocuments = [];
  const skipped = [];
  for (const { document } of preflight.validated) {
    if (previous.has(document._id) && !replace)
      skipped.push({ id: document._id, reason: "exists" });
    else savedDocuments.push(document);
  }
  if (savedDocuments.length) {
    await cpTransaction(
      savedDocuments.map((document) => ({
        type: previous.has(document._id) ? "document.update" : "document.create",
        payload: document
      }))
    );
  }
  const report = {
    saved: savedDocuments.map((document, index) => ({ index, id: document._id, ok: true })),
    skipped,
    errors: preflight.errors,
    atomic,
    rolledBack: 0
  };
  const inverse = savedDocuments
    .map((document) => {
      const old = previous.get(document._id);
      return old ? operation.save(old) : operation.remove(document._id);
    })
    .reverse();
  const applied = {
    result: report,
    savedDocuments,
    inverse: inverse.length ? operation.batch(inverse, `Undo ${label}`) : null
  };
  if (report.errors.length) {
    const error = new Error(`Batch rejected ${report.errors.length} document(s)`);
    error.report = report;
    error.applied = applied;
    throw error;
  }
  return applied;
}
