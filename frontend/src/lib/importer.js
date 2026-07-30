import {
  isStarIntelDocument,
  SCHEMA_PROFILE,
  SCHEMA_PROFILE_VERSION,
  SCHEMA_REVISION,
  SCHEMA_URI,
  SCHEMA_VERSION
} from "starintel_doc";

export const validatorInfo = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  schemaRevision: SCHEMA_REVISION,
  schemaUri: SCHEMA_URI,
  profile: SCHEMA_PROFILE,
  profileVersion: SCHEMA_PROFILE_VERSION
});

export const IMPORT_LIMITS = Object.freeze({
  maxFiles: 256,
  maxTotalBytes: 1_073_741_824,
  maxFileBytes: 536_870_912,
  maxRecordBytes: 8_388_608,
  maxDocuments: 1_000_000,
  maxErrors: 1_000
});

function extension(name) {
  return String(name || "")
    .toLowerCase()
    .split(".")
    .pop();
}

async function parseJsonLines(file, sourceName, limits) {
  const documents = [];
  const origins = [];
  const errors = [];
  if (typeof file.stream !== "function" || typeof TextDecoderStream === "undefined") {
    const text = await file.text();
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
      const line = index + 1;
      if (rawLine.length > limits.maxRecordBytes) {
        throw new RangeError(`Record ${line} exceeds the import record limit`);
      }
      if (!rawLine.trim()) continue;
      try {
        documents.push(JSON.parse(rawLine));
        origins.push({ file: sourceName, line, record: documents.length });
      } catch (error) {
        if (errors.length < limits.maxErrors) {
          errors.push({ file: sourceName, line, message: error.message });
        }
      }
      if (documents.length > limits.maxDocuments) {
        throw new RangeError("Import document limit exceeded");
      }
    }
    return { documents, origins, errors };
  }
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let line = 0;
  try {
    for (;;) {
      const { value = "", done } = await reader.read();
      buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + 1);
        line += 1;
        if (raw.length > limits.maxRecordBytes)
          throw new RangeError(`Record ${line} exceeds the import record limit`);
        if (!raw.trim()) continue;
        try {
          documents.push(JSON.parse(raw));
          origins.push({ file: sourceName, line, record: documents.length });
        } catch (error) {
          if (errors.length < limits.maxErrors)
            errors.push({ file: sourceName, line, message: error.message });
        }
        if (documents.length > limits.maxDocuments)
          throw new RangeError("Import document limit exceeded");
        if (documents.length % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (buffer.length > limits.maxRecordBytes)
        throw new RangeError(`Record ${line + 1} exceeds the import record limit`);
      if (done) break;
    }
    if (buffer.trim()) {
      line += 1;

      try {
        documents.push(JSON.parse(buffer));

        origins.push({ file: sourceName, line, record: documents.length });
      } catch (error) {
        if (errors.length < limits.maxErrors) {
          errors.push({ file: sourceName, line, message: error.message });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { documents, origins, errors };
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else value += character;
  }
  values.push(value);
  return values;
}

function parseCsv(text, sourceName) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { documents: [], origins: [], errors: [] };
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const documents = [];
  const origins = [];
  const errors = [];

  lines.slice(1).forEach((line, rowIndex) => {
    const values = parseCsvLine(line);
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    try {
      const data = raw.data ? JSON.parse(raw.data) : {};
      for (const [key, value] of Object.entries(raw)) {
        if (!key.startsWith("data.") || value === "") continue;
        data[key.slice(5)] = value;
      }
      documents.push({
        _id: raw._id,
        dataset: raw.dataset || "import",
        dtype: raw.dtype || "document",
        title: raw.title || "",
        summary: raw.summary || "",
        description: raw.description || "",
        tags: raw.tags
          ? raw.tags
              .split("|")
              .map((tag) => tag.trim())
              .filter(Boolean)
          : [],
        sources: raw.sources ? JSON.parse(raw.sources) : [],
        evidence: raw.evidence ? JSON.parse(raw.evidence) : [],
        data
      });
      origins.push({ file: sourceName, line: rowIndex + 2, record: rowIndex + 1 });
    } catch (error) {
      errors.push({ file: sourceName, line: rowIndex + 2, message: error.message });
    }
  });
  return { documents, origins, errors };
}

function unwrapJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.documents)) return value.documents;
  if (Array.isArray(value?.docs)) return value.docs;
  return value && typeof value === "object" ? [value] : [];
}

async function parseFile(file, limits) {
  const kind = extension(file.name);
  if (file.size > limits.maxFileBytes)
    throw new RangeError(`${file.name} exceeds the import file limit`);
  if (["jsonl", "ndjson"].includes(kind)) return parseJsonLines(file, file.name, limits);
  const text = await file.text();
  if (kind === "csv") return parseCsv(text, file.name);
  try {
    const documents = unwrapJson(JSON.parse(text));
    return {
      documents,
      origins: documents.map((_, index) => ({ file: file.name, record: index + 1 })),
      errors: []
    };
  } catch (error) {
    return { documents: [], origins: [], errors: [{ file: file.name, message: error.message }] };
  }
}

function manifestReferences(document) {
  if (!document || !["dataset-manifest", "actor-manifest"].includes(document.dtype)) return [];
  const files = Array.isArray(document.data?.files) ? document.data.files : [];
  return files
    .map((entry) => (typeof entry === "string" ? entry : entry?.path || entry?.name || entry?.file))
    .filter(Boolean);
}

export async function collectImportDocuments(fileList, options = {}) {
  const files = Array.from(fileList || []);
  const limits = { ...IMPORT_LIMITS, ...(options.limits || {}) };
  if (files.length > limits.maxFiles)
    throw new RangeError(`Import file limit exceeded: ${limits.maxFiles}`);
  const totalBytes = files.reduce((total, file) => total + Number(file.size || 0), 0);
  if (totalBytes > limits.maxTotalBytes)
    throw new RangeError(`Import byte limit exceeded: ${limits.maxTotalBytes}`);
  const resolveManifestReferences = options.resolveManifestReferences === true;
  const byName = new Map(files.map((file) => [file.name, file]));
  const parsed = new Map();
  const errors = [];

  for (const file of files) {
    const result = await parseFile(file, limits);
    parsed.set(file.name, result);
    errors.push(...result.errors);
  }

  const documents = [];
  const origins = [];
  const includedFiles = new Set();
  const include = (name) => {
    if (includedFiles.has(name)) return;
    includedFiles.add(name);
    const result = parsed.get(name) || { documents: [], origins: [] };
    documents.push(...result.documents);
    origins.push(...result.origins);
    if (resolveManifestReferences) {
      for (const document of result.documents) {
        for (const reference of manifestReferences(document)) {
          const candidate = byName.has(reference)
            ? reference
            : [...byName.keys()].find((key) => key.endsWith(`/${reference}`));
          if (candidate) include(candidate);
          else
            errors.push({ file: name, message: `manifest reference not supplied: ${reference}` });
        }
      }
    }
  };

  files.forEach((file) => include(file.name));
  return { documents, origins, errors, files: [...includedFiles] };
}

export async function importFiles(fileList, saveBatch, options = {}) {
  const collected = await collectImportDocuments(fileList, options);
  const records = collected.documents.map((document, index) => ({
    document,
    origin: collected.origins[index] || { record: index + 1 },
    index
  }));
  const obviousInvalid = records.filter(
    ({ document }) => !document || typeof document !== "object"
  );
  const candidateRecords = records.filter(
    ({ document }) => document && typeof document === "object"
  );
  const candidates = candidateRecords.map(({ document }) => document);
  const origins = candidateRecords.map(({ origin }) => origin);
  const parseErrors = [
    ...collected.errors,
    ...obviousInvalid.map(({ index, origin }) => ({
      ...origin,
      message: `record ${origin.record || index + 1} is not an object`
    }))
  ];
  const summary = {
    parseErrors,
    fileCount: collected.files.length,
    candidateCount: candidates.length,
    recognizedCount: candidates.filter(isStarIntelDocument).length,
    manifestMode: options.resolveManifestReferences === true ? "bundle" : "documents"
  };
  const decorate = (report = {}) => ({
    saved: [],
    skipped: [],
    errors: [],
    ...report,
    ...summary,
    validator: validatorInfo,
    importedIds: (report.saved || []).map((item) => item.id),
    savedCount: (report.saved || []).length,
    skippedCount: (report.skipped || []).length,
    errorCount: (report.errors || []).length,
    parseErrorCount: parseErrors.length
  });

  if (options.atomic !== false && parseErrors.length) {
    const error = new Error(`Atomic import rejected ${parseErrors.length} parse error(s)`);
    error.report = decorate({ atomic: true, rejected: true });
    throw error;
  }

  try {
    return decorate(await saveBatch(candidates, { ...options, origins }));
  } catch (error) {
    error.report = decorate(error.report);
    throw error;
  }
}

export function documentsToJsonl(documents) {
  return `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`;
}

export function downloadText(filename, text, type = "application/x-ndjson") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
