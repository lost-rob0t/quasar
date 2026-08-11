import { schema } from "starintel_doc";

const STORAGE_KEY = "quasar.custom-predicates.v1";
const RECENT_KEY = "quasar.recent-predicates.v1";

// Generated from lost-rob0t/star-cl src/relations.lisp at e7c987222a17769d35d528ef4fef869f5ea258a1.
// Keep the source IDs intact. Underscore aliases are added for UI search and custom-predicate migration.
export const STAR_CL_PREDICATE_IDS = Object.freeze([
  "related-to",
  "same-as",
  "duplicate-of",
  "aka",
  "alias-of",
  "username-of",
  "email-of",
  "phone-of",
  "account-of",
  "member-of",
  "employed-by",
  "contractor-for",
  "works-with",
  "manages",
  "reports-to",
  "owns",
  "owned-by",
  "controls",
  "controlled-by",
  "operates",
  "operated-by",
  "administers",
  "administered-by",
  "registered-to",
  "registrant-of",
  "whois-registrant-of",
  "whois-admin-of",
  "whois-tech-of",
  "located-at",
  "geolocated-at",
  "seen-at",
  "communicates-with",
  "contacted",
  "contacted-by",
  "mentions",
  "replies-to",
  "follows",
  "links-to",
  "redirects-to",
  "canonical-url-of",
  "hosts",
  "hosted-by",
  "served-by",
  "resolves-to",
  "ptr-to",
  "has-a",
  "has-aaaa",
  "has-cname",
  "has-ns",
  "has-mx",
  "has-txt",
  "has-spf",
  "has-dkim",
  "has-dmarc",
  "has-soa",
  "behind-cdn",
  "belongs-to-asn",
  "served-from",
  "shares-ip-with",
  "shares-asn-with",
  "hosts-service",
  "listens-on",
  "exposes-port",
  "runs",
  "runs-on",
  "leaked-in",
  "credential-for",
  "compromised-by",
  "observed-on",
  "observed-by",
  "collected-from",
  "extracted-from",
  "derived-from",
  "downloaded-from",
  "uploaded-to",
  "created-by",
  "modified-by",
  "hashes-to",
  "matches-hash",
  "evidence-of",
  "indicates",
  "attributed-to",
  "uses",
  "targets",
  "exploits",
  "mitigates",
  "c2-for",
  "in-scope-of",
  "out-of-scope-of",
  "discovered-by",
  "scanned-by",
  "has-finding",
  "vulnerable-to"
]);

function storage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function readJson(key, fallback) {
  try {
    return JSON.parse(storage()?.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  storage()?.setItem(key, JSON.stringify(value));
}

function labelFor(id) {
  return id
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizedSimilarityKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "_");
}

function predicateDefinition(id, source, extra = {}) {
  const aliases = new Set(extra.aliases || []);
  if (id.includes("-")) aliases.add(id.replaceAll("-", "_"));
  if (id.includes("_")) aliases.add(id.replaceAll("_", "-"));
  return {
    id,
    label: extra.label || labelFor(id),
    aliases: [...aliases].filter((alias) => alias !== id),
    source,
    sourceTypes: extra.sourceTypes || ["*"],
    targetTypes: extra.targetTypes || ["*"],
    hint: extra.hint || "StarIntel relation predicate",
    common: Boolean(extra.common),
    custom: Boolean(extra.custom),
    usageCount: Number(extra.usageCount || 0)
  };
}

export const STAR_CL_PREDICATES = Object.freeze(
  STAR_CL_PREDICATE_IDS.map((id, index) =>
    predicateDefinition(id, "star-cl", {
      common: index < 35,
      hint: `star-cl · ${labelFor(id)}`
    })
  )
);

function schemaPredicateCandidates(activeSchema = schema) {
  const definitions = [];
  const declared = activeSchema["x-starintel-predicates"] || activeSchema.$defs?.predicates || [];
  const rows = Array.isArray(declared)
    ? declared
    : Object.entries(declared).map(([id, value]) => ({ id, ...value }));
  for (const row of rows) {
    if (typeof row === "string") definitions.push(predicateDefinition(row, "active spec"));
    else if (row?.id) definitions.push(predicateDefinition(row.id, "active spec", row));
  }
  for (const variant of activeSchema.allOf || []) {
    const dtype = variant.if?.properties?.dtype?.const;
    if (dtype !== "relation") continue;
    const properties = variant.then?.properties?.data?.properties || {};
    const enumValues =
      properties.predicate?.enum || variant.then?.properties?.predicate?.enum || [];
    for (const id of enumValues) definitions.push(predicateDefinition(id, "active spec"));
  }
  return definitions;
}

export function predicatesFromDocuments(documents = []) {
  const counts = new Map();
  for (const document of documents) {
    if (document.dtype !== "relation") continue;
    const id = document.data?.predicate || document.predicate;
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()].map(([id, usageCount]) =>
    predicateDefinition(id, "active dataset", { usageCount })
  );
}

export function loadCustomPredicates() {
  return readJson(STORAGE_KEY, [])
    .filter((item) => item?.id)
    .map((item) => predicateDefinition(item.id, "custom", { ...item, custom: true }));
}

export function recentPredicateIds() {
  return readJson(RECENT_KEY, []).filter(Boolean);
}

export function rememberPredicate(id) {
  const next = [id, ...recentPredicateIds().filter((value) => value !== id)].slice(0, 30);
  writeJson(RECENT_KEY, next);
  return next;
}

export function normalizeCustomPredicateId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

export function validateCustomPredicateId(value) {
  const id = normalizeCustomPredicateId(value);
  if (!id) return { valid: false, id, message: "Enter a predicate ID." };
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id)) {
    return { valid: false, id, message: "Predicate must use lowercase snake_case." };
  }
  return { valid: true, id, message: "" };
}

function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
  }
  return rows[left.length][right.length];
}

export function similarPredicates(value, catalog, limit = 5) {
  const needle = normalizedSimilarityKey(value);
  if (!needle) return [];
  return catalog
    .map((item) => ({ item, distance: editDistance(needle, normalizedSimilarityKey(item.id)) }))
    .filter(
      ({ distance, item }) =>
        normalizedSimilarityKey(item.id) === needle ||
        distance <= Math.max(1, Math.floor(needle.length / 4))
    )
    .sort(
      (left, right) => left.distance - right.distance || left.item.id.localeCompare(right.item.id)
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

export function saveCustomPredicate(input, existingCatalog = []) {
  const validation = validateCustomPredicateId(input.id || input.label);
  if (!validation.valid) throw new Error(validation.message);
  const duplicate = existingCatalog.find(
    (item) => normalizedSimilarityKey(item.id) === normalizedSimilarityKey(validation.id)
  );
  if (duplicate) throw new Error(`A similar predicate already exists: ${duplicate.id}`);
  const definition = predicateDefinition(validation.id, "custom", {
    custom: true,
    label: input.label?.trim() || labelFor(validation.id),
    aliases: input.aliases || [],
    sourceTypes: input.sourceTypes?.length ? input.sourceTypes : ["*"],
    targetTypes: input.targetTypes?.length ? input.targetTypes : ["*"],
    hint: input.hint?.trim() || "Custom relation predicate"
  });
  const next = [...loadCustomPredicates().filter((item) => item.id !== definition.id), definition];
  writeJson(STORAGE_KEY, next);
  return definition;
}

function compatible(types, selected) {
  return !selected || !types?.length || types.includes("*") || types.includes(selected);
}

function mergeCatalogRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const current = merged.get(row.id);
    if (!current) {
      merged.set(row.id, { ...row });
      continue;
    }
    merged.set(row.id, {
      ...current,
      ...row,
      aliases: [...new Set([...(current.aliases || []), ...(row.aliases || [])])],
      common: current.common || row.common,
      custom: current.custom || row.custom,
      usageCount: Math.max(current.usageCount || 0, row.usageCount || 0)
    });
  }
  return [...merged.values()];
}

export function buildPredicateCatalog({ activeSchema = schema, documents = [] } = {}) {
  return mergeCatalogRows([
    ...STAR_CL_PREDICATES,
    ...schemaPredicateCandidates(activeSchema),
    ...predicatesFromDocuments(documents),
    ...loadCustomPredicates()
  ]);
}

export function searchPredicates(catalog, options = {}) {
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  const recent = new Set(options.recentIds || recentPredicateIds());
  const dataset = new Set(
    options.datasetIds || predicatesFromDocuments(options.documents || []).map((item) => item.id)
  );
  return catalog
    .filter(
      (item) =>
        compatible(item.sourceTypes, options.sourceType) &&
        compatible(item.targetTypes, options.targetType)
    )
    .map((item) => {
      const haystack = [item.id, item.label, ...(item.aliases || [])].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) return null;
      const exact =
        query &&
        (item.id.toLowerCase() === query ||
          item.aliases?.some((alias) => alias.toLowerCase() === query));
      const starts = query && haystack.split(/\s+/).some((part) => part.startsWith(query));
      const score =
        (exact ? 1000 : 0) +
        (starts ? 250 : 0) +
        (recent.has(item.id) ? 180 : 0) +
        (dataset.has(item.id) ? 120 : 0) +
        (item.common ? 80 : 0) +
        Math.min(item.usageCount || 0, 50);
      return { ...item, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, options.limit || 80);
}
