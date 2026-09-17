import PouchDB from "pouchdb-browser";

const db = new PouchDB("quasar-notes-v1");
const PAGE_PREFIX = "note-page:";
const BLOCK_PREFIX = "note-block:";

function now() {
  return new Date().toISOString();
}

function uuid() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

export function normalizePageTitle(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function pageId(title) {
  return `${PAGE_PREFIX}${normalizePageTitle(title).toLowerCase()}`;
}

function references(content) {
  const refs = new Set();
  const pagePattern = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = pagePattern.exec(String(content || "")))) {
    const title = normalizePageTitle(match[1]);
    if (title) refs.add(title);
  }
  return [...refs];
}

function blockReferences(content) {
  const refs = new Set();
  const pattern = /\(\(([a-zA-Z0-9_-]{8,})\)\)/g;
  let match;
  while ((match = pattern.exec(String(content || "")))) refs.add(match[1]);
  return [...refs];
}

function tags(content) {
  const values = new Set();
  const pattern = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
  let match;
  while ((match = pattern.exec(String(content || "")))) values.add(match[2]);
  return [...values];
}

export async function ensureNotePage(title, kind = "page") {
  const normalized = normalizePageTitle(title);
  if (!normalized) throw new Error("A note page title is required");
  const _id = pageId(normalized);
  try {
    return await db.get(_id);
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  const document = {
    _id,
    type: "note-page",
    title: normalized,
    kind,
    createdAt: now(),
    updatedAt: now()
  };
  const response = await db.put(document);
  return { ...document, _rev: response.rev };
}

export async function listNotePages() {
  const response = await db.allDocs({
    include_docs: true,
    startkey: PAGE_PREFIX,
    endkey: `${PAGE_PREFIX}\ufff0`
  });
  return response.rows
    .map((row) => row.doc)
    .filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function listNoteBlocks(targetPageId) {
  const response = await db.allDocs({
    include_docs: true,
    startkey: BLOCK_PREFIX,
    endkey: `${BLOCK_PREFIX}\ufff0`
  });
  return response.rows
    .map((row) => row.doc)
    .filter((doc) => doc?.pageId === targetPageId)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a._id.localeCompare(b._id));
}

export async function addNoteBlock(targetPageId, content = "", afterOrder = null, parentId = null) {
  const blocks = await listNoteBlocks(targetPageId);
  const order = afterOrder == null ? (blocks.at(-1)?.order || 0) + 1024 : Number(afterOrder) + 512;
  const timestamp = now();
  const blockUuid = uuid();
  const document = {
    _id: `${BLOCK_PREFIX}${blockUuid}`,
    uuid: blockUuid,
    type: "note-block",
    pageId: targetPageId,
    parentId,
    order,
    content: String(content),
    refs: references(content),
    blockRefs: blockReferences(content),
    tags: tags(content),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const response = await db.put(document);
  return { ...document, _rev: response.rev };
}

export async function updateNoteBlock(block, content) {
  const next = {
    ...block,
    uuid: block.uuid || String(block._id || "").replace(BLOCK_PREFIX, ""),
    content: String(content),
    refs: references(content),
    blockRefs: blockReferences(content),
    tags: tags(content),
    updatedAt: now()
  };
  const response = await db.put(next);
  return { ...next, _rev: response.rev };
}

export async function updateNoteBlockParent(block, parentId) {
  if (!block?._id) throw new Error("A note block is required");
  if (parentId === block._id) throw new Error("A block cannot be its own parent");
  const next = { ...block, parentId: parentId || null, updatedAt: now() };
  const response = await db.put(next);
  return { ...next, _rev: response.rev };
}

export async function deleteNoteBlock(block) {
  if (!block?._id || !block?._rev) return;
  const blocks = await listNoteBlocks(block.pageId);
  const children = blocks.filter((candidate) => candidate.parentId === block._id);
  if (children.length) {
    await db.bulkDocs(
      children.map((child) => ({ ...child, parentId: block.parentId || null, updatedAt: now() }))
    );
  }
  await db.remove(block);
}

export async function findBacklinks(title) {
  const target = normalizePageTitle(title).toLowerCase();
  if (!target) return [];
  const response = await db.allDocs({
    include_docs: true,
    startkey: BLOCK_PREFIX,
    endkey: `${BLOCK_PREFIX}\ufff0`
  });
  return response.rows
    .map((row) => row.doc)
    .filter((doc) => doc?.refs?.some((ref) => normalizePageTitle(ref).toLowerCase() === target));
}

export async function findBlockBacklinks(blockUuid) {
  const target = String(blockUuid || "");
  if (!target) return [];
  const response = await db.allDocs({
    include_docs: true,
    startkey: BLOCK_PREFIX,
    endkey: `${BLOCK_PREFIX}\ufff0`
  });
  return response.rows.map((row) => row.doc).filter((doc) => doc?.blockRefs?.includes(target));
}

export function todayJournalTitle(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function ensureTodayJournal() {
  return ensureNotePage(todayJournalTitle(), "journal");
}

export async function noteGraph() {
  const pages = await listNotePages();
  const pageByTitle = new Map(pages.map((page) => [page.title.toLowerCase(), page]));
  const response = await db.allDocs({
    include_docs: true,
    startkey: BLOCK_PREFIX,
    endkey: `${BLOCK_PREFIX}\ufff0`
  });
  const edges = [];
  for (const block of response.rows.map((row) => row.doc).filter(Boolean)) {
    const source = pages.find((page) => page._id === block.pageId);
    if (!source) continue;
    for (const ref of block.refs || []) {
      const target = pageByTitle.get(ref.toLowerCase());
      if (target) edges.push({ source: source._id, target: target._id, blockId: block._id });
    }
  }
  return { pages, edges };
}
