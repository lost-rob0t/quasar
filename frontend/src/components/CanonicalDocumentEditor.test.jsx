import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
vi.mock("../store", () => ({
  useQuasar: () => ({ documents: [], execute: vi.fn(), setNotice: vi.fn() })
}));
vi.mock("../lib/operations", () => ({ operation: { save: (value) => value } }));
import Editor, { createCanonicalDraft, parseCanonicalField } from "./CanonicalDocumentEditor";

describe("native canonical editor", () => {
  it("creates flat documents and rejects unsupported type routes", () => {
    expect(createCanonicalDraft("person", "test", "person:one")).toEqual({
      id: "person:one",
      dataset: "test",
      dtype: "person",
      schemaVersion: "0.10.1"
    });
    expect(() => createCanonicalDraft("unrecognized")).toThrow(/Unknown/);
  });
  it("renders generated field names and canonical defaults", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/documents/new?dtype=person"]}>
        <Editor mode="create" />
      </MemoryRouter>
    );
    expect(html).toContain("0.10.1");
    expect(html).toContain("schemaVersion");
    expect(html).toContain("fullName");
    expect(html).not.toContain("schema_version");
  });
  it("keeps decimal strings exact and rejects unsafe native integers", () => {
    expect(parseCanonicalField("0.70000000000000001", { $ref: "#/$defs/ConfidenceScore" })).toBe(
      "0.70000000000000001"
    );
    expect(() => parseCanonicalField("9007199254740993", { type: "integer" })).toThrow(
      /exact JSON number/
    );
    expect(
      parseCanonicalField('{"schema":"org.starintel/core@1/person","id":"person:a"}', {
        $ref: "#/$defs/StarReference"
      })
    ).toEqual({ schema: "org.starintel/core@1/person", id: "person:a" });
  });
});

it("opens an existing graph draft through the canonical field mapping", () => {
  const draft = {
    _id: "event:draft",
    dataset: "test",
    dtype: "event",
    schema_version: "0.9.0",
    data: { name: "Unsaved meeting", event_kind: "meeting" }
  };
  vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify(draft) });
  try {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/documents/new?draft=one&returnTo=graph"]}>
        <Editor mode="create" />
      </MemoryRouter>
    );
    expect(html).toContain("Unsaved meeting");
    expect(html).toContain("eventKind");
    expect(html).not.toContain("requires explicit migration");
  } finally {
    vi.unstubAllGlobals();
  }
});
