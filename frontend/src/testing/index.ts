import type { QuasarDocument } from "../core";

export function createTestDocument(overrides: Partial<QuasarDocument> = {}): QuasarDocument {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    _id: "test:document",
    dataset: "test",
    dtype: "entity",
    version: 1,
    date_added: timestamp,
    date_updated: timestamp,
    sources: [],
    data: {},
    ...overrides
  };
}

export * from "./graph-fixtures";
