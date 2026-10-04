import { createDocument } from "starintel_doc";
import { parseBrowserDocumentJson } from "./canonical-document";

// Shared semantic contract: quasar.wireless-import.v1. Raw evidence is retained;
// a radio address is never treated as an identity or a person's location.
const bytes = (value) => new TextEncoder().encode(value).length;
const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
async function digest(text) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof text === "string" ? new TextEncoder().encode(text) : text
      )
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

// RFC 4180 records, including escaped quotes and embedded newlines. This scanner
// bounds each record before allocating a field array and rejects broken quoting.
export function* csvRecords(text, maxRecordBytes) {
  let start = 0,
    quoted = false,
    line = 1,
    recordLine = 1;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    }
    if (i - start > maxRecordBytes) throw new RangeError("Wireless CSV record limit exceeded");
    if ((char === "\n" && !quoted) || i === text.length) {
      const raw = text.slice(start, i).replace(/\r$/, "");
      if (bytes(raw) > maxRecordBytes) throw new RangeError("Wireless CSV record limit exceeded");
      if (raw.trim()) yield { raw, line: recordLine };
      start = i + 1;
      recordLine = line + 1;
    }
    if (char === "\n") line++;
  }
  if (quoted) throw new TypeError("Unterminated quoted CSV field");
}
function fields(raw) {
  const values = [];
  let value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') {
      if (quoted && raw[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (!value && !closed) quoted = true;
      else throw new TypeError("Unexpected quote in CSV field");
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
      closed = false;
    } else {
      if (closed) throw new TypeError("Text after quoted CSV field");
      value += char;
    }
  }
  if (quoted) throw new TypeError("Unterminated quoted CSV field");
  values.push(value);
  return values;
}
function integer(value, label) {
  if (value === undefined || value === "") return undefined;
  if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new TypeError(`Invalid ${label}`);
  return Number(value);
}
export async function wirelessDocument(raw, format, dataset, file, line) {
  if (!dataset || dataset.length > 256)
    throw new TypeError("Wireless import requires a dataset (1–256 characters)");
  const hash = await digest(stable(raw));
  const id = `wireless-import:${await digest(`${dataset}\n${format}\n${hash}`)}`;
  const base = {
    id,
    dataset,
    collectionMethod: "file-import",
    collector: "quasar.wireless-import.v1",
    normalizedHash: hash,
    hashAlgorithm: "sha256",
    raw,
    provenance: {
      format,
      file,
      line,
      recordHash: hash,
      locationMeaning: "source observation; not a person or guaranteed device position"
    }
  };
  if (format === "wigle-csv" && raw.Type === "WIFI") {
    if (!/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(raw.MAC)) throw new TypeError("Invalid WiGLE MAC");
    const optional = {};
    for (const [input, output] of [
      ["Channel", "channel"],
      ["Frequency", "frequencyMhz"],
      ["RSSI", "signalDbm"]
    ]) {
      const value = integer(raw[input], input);
      if (value !== undefined) optional[output] = value;
    }
    for (const [name, bound] of [
      ["CurrentLatitude", 90],
      ["CurrentLongitude", 180]
    ]) {
      if (raw[name] && (!Number.isFinite(Number(raw[name])) || Math.abs(Number(raw[name])) > bound))
        throw new TypeError(`Invalid ${name}`);
    }
    return createDocument("wireless-network", {
      ...base,
      ...optional,
      bssid: raw.MAC.toLowerCase(),
      ssid: raw.SSID,
      authMode: raw.AuthMode,
      security: "unknown"
    });
  }
  // Kismet contains many PHY/device types. Preserve them without guessing AP,
  // station, cellular, Bluetooth, or person semantics from a MAC or display name.
  return createDocument("document", base);
}

export async function parseWirelessFile(file, format, dataset, limits) {
  if (file.size > Math.min(limits.maxFileBytes, 16 * 1024 * 1024))
    throw new RangeError("Wireless preview limit is 16 MiB; split/export a smaller file");
  const sourceBytes =
    typeof file.arrayBuffer === "function"
      ? new Uint8Array(await file.arrayBuffer())
      : new TextEncoder().encode(await file.text());
  if (sourceBytes.length > Math.min(limits.maxFileBytes, 16 * 1024 * 1024))
    throw new RangeError("Wireless byte limit exceeded");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sourceBytes);
  const sourceArtifacts = await sourceCustody(sourceBytes, format, dataset, file.name);
  const source = sourceArtifacts[0];
  const documents = [],
    origins = [],
    errors = [],
    seen = new Set();
  let skippedDuplicates = 0;
  async function append(raw, line) {
    if (documents.length >= Math.min(limits.maxDocuments, 10000))
      throw new RangeError("Wireless document limit exceeded");
    try {
      const document = await wirelessDocument(raw, format, dataset, file.name, line);
      document.sources = [{ schema: "org.starintel/core@1/file", id: source.id }];
      document.provenance.sourceByteHash = source.bytesHash;
      if (seen.has(document.id)) {
        skippedDuplicates++;
        return;
      }
      seen.add(document.id);
      documents.push(document);
      origins.push({ file: file.name, line, record: documents.length });
    } catch (error) {
      if (errors.length >= limits.maxErrors) throw new RangeError("Wireless error limit exceeded");
      errors.push({ file: file.name, line, message: error.message });
    }
  }
  if (format === "wigle-csv") {
    let headers;
    for (const { raw, line } of csvRecords(text.replace(/^\uFEFF/, ""), limits.maxRecordBytes)) {
      if (!headers && raw.startsWith("WigleWifi-")) continue;
      const row = fields(raw);
      if (!headers) {
        headers = row;
        if (
          new Set(headers).size !== headers.length ||
          !["MAC", "SSID", "AuthMode", "FirstSeen", "Type"].every((h) => headers.includes(h))
        )
          throw new TypeError("Expected WiGLE CSV header MAC,SSID,AuthMode,FirstSeen,…,Type");
        continue;
      }
      if (row.length !== headers.length)
        throw new TypeError(`CSV column count mismatch at line ${line}`);
      await append(Object.fromEntries(headers.map((header, i) => [header, row[i]])), line);
    }
    if (!headers) throw new TypeError("Missing WiGLE CSV header");
  } else if (format === "kismet-json") {
    // Official dump utility supports a JSON array or one device per line.
    const records = text.trimStart().startsWith("[")
      ? parseBrowserDocumentJson(text).map((raw, i) => ({ raw, line: i + 1 }))
      : text
          .split(/\r?\n/)
          .map((raw, i) => ({ text: raw, line: i + 1 }))
          .filter((r) => r.text.trim());
    for (const record of records) {
      if (bytes(record.text || stable(record.raw)) > limits.maxRecordBytes)
        throw new RangeError("Kismet record limit exceeded");
      const raw = record.raw || parseBrowserDocumentJson(record.text);
      if (
        !raw ||
        Array.isArray(raw) ||
        typeof raw !== "object" ||
        !Object.hasOwn(raw, "kismet.device.base.key")
      )
        throw new TypeError(`Expected Kismet device object at record ${record.line}`);
      await append(raw, record.line);
    }
  } else throw new TypeError(`Unsupported wireless format: ${format}`);
  source.extensions.quasarSource.recordIds = documents.map((document) => document.id);
  source.extensions.quasarSource.recordCount = documents.length;
  return { documents, origins, errors, skippedDuplicates, sourceArtifacts };
}

async function sourceCustody(sourceBytes, format, dataset, filename) {
  const sourceHash = await digest(sourceBytes);
  const id = `wireless-source:${await digest(`${dataset}\n${format}\n${sourceHash}`)}`;
  const chunks = [];
  for (let start = 0, index = 0; start < sourceBytes.length; start += 65536, index++) {
    const part = sourceBytes.slice(start, start + 65536);
    let binary = "";
    for (const byte of part) binary += String.fromCharCode(byte);
    chunks.push(
      createDocument("artifact", {
        id: `${id}:chunk:${index}`,
        dataset,
        encoding: "base64",
        rawContent: btoa(binary),
        bytesHash: await digest(part),
        hashAlgorithm: "sha256",
        sizeBytes: part.length,
        extensions: { quasarSourceChunk: { sourceId: id, index } }
      })
    );
  }
  const source = createDocument("file", {
    id,
    dataset,
    filename,
    bytesHash: sourceHash,
    bytesHashAlgorithm: "sha256",
    sizeBytes: sourceBytes.length,
    extensions: {
      quasarSource: {
        format,
        chunkIds: chunks.map((chunk) => chunk.id),
        chunkCount: chunks.length,
        chunkSize: 65536
      }
    }
  });
  const artifacts = [source, ...chunks];
  await restoreSourceBytes(artifacts);
  return artifacts;
}

// Recovery is bounded and verifies declared ordering, byte counts and every hash.
export async function restoreSourceBytes(artifacts) {
  const source = artifacts[0],
    manifest = source?.extensions?.quasarSource;
  if (
    !manifest ||
    source.dtype !== "file" ||
    manifest.chunkSize !== 65536 ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 0 ||
    source.sizeBytes > 16 * 1024 * 1024 ||
    manifest.chunkCount !== Math.ceil(source.sizeBytes / 65536) ||
    manifest.chunkIds.length !== manifest.chunkCount ||
    artifacts.length !== manifest.chunkCount + 1
  )
    throw new TypeError("Invalid source custody manifest");
  const output = new Uint8Array(source.sizeBytes);
  let offset = 0;
  for (let index = 0; index < manifest.chunkCount; index++) {
    const chunk = artifacts[index + 1];
    if (
      chunk.id !== manifest.chunkIds[index] ||
      chunk.dtype !== "artifact" ||
      chunk.extensions?.quasarSourceChunk?.index !== index ||
      chunk.extensions?.quasarSourceChunk?.sourceId !== source.id ||
      chunk.encoding !== "base64" ||
      chunk.rawContent.length > 87384
    )
      throw new TypeError("Invalid source chunk order or encoding");
    const part = Uint8Array.from(atob(chunk.rawContent), (c) => c.charCodeAt(0));
    if (
      part.length !== Math.min(65536, source.sizeBytes - offset) ||
      part.length !== chunk.sizeBytes ||
      (await digest(part)) !== chunk.bytesHash
    )
      throw new TypeError("Source chunk byte/hash mismatch");
    output.set(part, offset);
    offset += part.length;
  }
  if ((await digest(output)) !== source.bytesHash) throw new TypeError("Source byte hash mismatch");
  return output;
}
