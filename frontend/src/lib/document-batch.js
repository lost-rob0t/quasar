import { assertDocument } from "starintel_doc";

export class PartialBatchCommitError extends Error {
  constructor(report) {
    super(`Batch rollback left ${report.saved.length} surviving document write(s)`);
    this.name = "PartialBatchCommitError";
    this.code = "PARTIAL_BATCH_COMMIT";
    this.report = report;
    this.applied = report;
  }
}

function incomingWins(incoming, existing, replace) {
  if (replace) return true;
  const incomingVersion = Number(incoming.version || 0);
  const existingVersion = Number(existing.version || 0);
  if (incomingVersion !== existingVersion) return incomingVersion > existingVersion;
  return String(incoming.date_updated || "") > String(existing.date_updated || "");
}

function originFields(origins, index) {
  const origin = origins[index] || {};
  return {
    ...(origin.file ? { file: origin.file } : {}),
    ...(origin.line ? { line: origin.line } : {}),
    record: origin.record || index + 1
  };
}

function validationDetails(error) {
  return (error?.errors || []).map((item) => ({
    path: item.instancePath || item.path || "",
    keyword: item.keyword || null,
    message: item.message || String(item)
  }));
}

export function validateDocumentBatch(inputs, { origins = [] } = {}) {
  const validated = [];
  const errors = [];
  const ids = new Map();

  for (let index = 0; index < inputs.length; index += 1) {
    try {
      const document = assertDocument(inputs[index]);
      const previousIndex = ids.get(document._id);
      if (previousIndex !== undefined) {
        errors.push({
          index,
          id: document._id,
          message: `Duplicate document ID in import batch; first seen at record ${previousIndex + 1}`,
          validation: [
            { path: "/_id", keyword: "unique", message: "must be unique within an import batch" }
          ],
          ...originFields(origins, index)
        });
        continue;
      }
      ids.set(document._id, index);
      validated.push({ index, document: { ...document }, origin: originFields(origins, index) });
    } catch (error) {
      errors.push({
        index,
        id: inputs[index]?._id || null,
        message: error.message,
        validation: validationDetails(error),
        ...originFields(origins, index)
      });
    }
  }

  return { validated, errors };
}

async function rollbackSuccessfulWrites(database, successful, existing) {
  const rollbackDocuments = successful.map(({ item, result }) => {
    const previous = existing.get(item.document._id);
    return previous
      ? { ...previous, _rev: result.rev }
      : { _id: result.id, _rev: result.rev, _deleted: true };
  });

  try {
    const results = await database.bulkDocs(rollbackDocuments);
    const surviving = [];
    const errors = [];
    results.forEach((result, position) => {
      if (result.ok) return;
      const write = successful[position];
      surviving.push({ index: write.item.index, id: write.result.id, rev: write.result.rev });
      errors.push({
        index: write.item.index,
        id: write.result.id,
        message: `Rollback failed: ${result.message || result.error}`,
        phase: "rollback",
        ...write.item.origin
      });
    });
    return { surviving, errors, rolledBack: successful.length - surviving.length };
  } catch (error) {
    return {
      surviving: successful.map(({ item, result }) => ({
        index: item.index,
        id: result.id,
        rev: result.rev
      })),
      errors: successful.map(({ item, result }) => ({
        index: item.index,
        id: result.id,
        message: `Rollback failed: ${error.message}`,
        phase: "rollback",
        ...item.origin
      })),
      rolledBack: 0
    };
  }
}

export async function commitDocumentBatch(
  database,
  inputs,
  { replace = false, atomic = true, origins = [], prepared = null } = {}
) {
  const preflight = prepared || validateDocumentBatch(inputs, { origins });
  if (atomic && preflight.errors.length) {
    return { saved: [], skipped: [], errors: preflight.errors, atomic, rolledBack: 0 };
  }

  const keys = preflight.validated.map(({ document }) => document._id);
  const existingRows = keys.length
    ? await database.allDocs({ keys, include_docs: true })
    : { rows: [] };
  const existing = new Map(
    existingRows.rows.filter((row) => row.doc).map((row) => [row.id, row.doc])
  );
  const writes = [];
  const skipped = [];

  for (const item of preflight.validated) {
    const current = existing.get(item.document._id);
    if (current && !incomingWins(item.document, current, replace)) {
      skipped.push({
        index: item.index,
        id: item.document._id,
        reason: "existing document is newer or equal",
        ...item.origin
      });
      continue;
    }
    const document = { ...item.document };
    if (current) document._rev = current._rev;
    else delete document._rev;
    writes.push({ ...item, document });
  }

  if (!writes.length) {
    return { saved: [], skipped, errors: preflight.errors, atomic, rolledBack: 0 };
  }

  let results;
  try {
    results = await database.bulkDocs(writes.map(({ document }) => document));
  } catch (error) {
    return {
      saved: [],
      skipped,
      errors: [
        ...preflight.errors,
        ...writes.map((item) => ({
          index: item.index,
          id: item.document._id,
          message: error.message,
          phase: "write",
          ...item.origin
        }))
      ],
      atomic,
      rolledBack: 0
    };
  }

  const successful = [];
  const writeErrors = [];
  results.forEach((result, position) => {
    const item = writes[position];
    if (result.ok) {
      successful.push({ item, result });
      return;
    }
    writeErrors.push({
      index: item.index,
      id: result.id || item.document._id,
      message: result.message || result.error,
      phase: "write",
      ...item.origin
    });
  });

  if (atomic && writeErrors.length && successful.length) {
    const rollback = await rollbackSuccessfulWrites(database, successful, existing);
    const report = {
      saved: rollback.surviving,
      skipped,
      errors: [...preflight.errors, ...writeErrors, ...rollback.errors],
      atomic: false,
      rollbackAttempted: true,
      rolledBack: rollback.rolledBack
    };
    if (rollback.surviving.length) throw new PartialBatchCommitError(report);
    return report;
  }

  return {
    saved: successful.map(({ item, result }) => ({
      index: item.index,
      id: result.id,
      rev: result.rev,
      ...item.origin
    })),
    skipped,
    errors: [...preflight.errors, ...writeErrors],
    atomic,
    rolledBack: 0
  };
}
