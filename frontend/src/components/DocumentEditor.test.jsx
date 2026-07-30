import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../store", () => ({ useQuasar: vi.fn() }));
vi.mock("../lib/operations", () => ({ operation: {} }));

import { useQuasar } from "../store";
import DocumentEditor, { SchemaField } from "./DocumentEditor";

function renderEditor(url) {
  useQuasar.mockReturnValue({
    documents: [],
    execute: vi.fn(),
    setNotice: vi.fn(),
    workspace: {},
    addDocumentsToActiveGraph: vi.fn(),
    runTargetActors: vi.fn()
  });
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/documents/new" element={<DocumentEditor mode="create" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("schema field controls", () => {
  it("renders arrays as repeatable values instead of JSON text", () => {
    const html = renderToStaticMarkup(
      <SchemaField
        name="occupations"
        fieldSchema={{ type: "array", items: { type: "string" } }}
        value='["Reporter","Editor"]'
        onChange={vi.fn()}
      />
    );
    expect(html).toContain("Reporter");
    expect(html).toContain("Editor");
    expect(html).toContain("Add value");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="schema-field-occupations"');
    expect(html).not.toContain("<textarea");
  });

  it("renders fixed objects as schema-typed property fields", () => {
    const html = renderToStaticMarkup(
      <SchemaField
        name="identity"
        fieldSchema={{
          type: "object",
          properties: {
            scheme: { type: "string" },
            active: { type: "boolean" }
          },
          required: ["scheme"]
        }}
        value='{"scheme":"registry","active":true}'
        onChange={vi.fn()}
      />
    );
    expect(html).toContain("Scheme *");
    expect(html).toContain("<small>string</small>");
    expect(html).toContain("registry");
    expect(html).toContain("Active");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("<textarea");
  });

  it("renders open objects as key/value rows", () => {
    const html = renderToStaticMarkup(
      <SchemaField
        name="attributes"
        fieldSchema={{ type: "object", additionalProperties: true }}
        value='{"region":"north"}'
        onChange={vi.fn()}
      />
    );
    expect(html).toContain('value="region"');
    expect(html).toContain('value="north"');
    expect(html).toContain("Add property");
    expect(html).not.toContain("<textarea");
  });

  it("uses date, datetime, number, URL, enum, and long-text controls", () => {
    expect(
      renderToStaticMarkup(
        <SchemaField
          name="started"
          fieldSchema={{ type: "string", format: "date" }}
          value=""
          onChange={vi.fn()}
        />
      )
    ).toContain('type="date"');
    expect(
      renderToStaticMarkup(
        <SchemaField
          name="observed_at"
          fieldSchema={{ type: "string", format: "date-time" }}
          value=""
          onChange={vi.fn()}
        />
      )
    ).toContain('type="datetime-local"');
    expect(
      renderToStaticMarkup(
        <SchemaField name="count" fieldSchema={{ type: "integer" }} value="" onChange={vi.fn()} />
      )
    ).toContain('step="1"');
    expect(
      renderToStaticMarkup(
        <SchemaField
          name="url"
          fieldSchema={{ type: "string", format: "uri" }}
          value=""
          onChange={vi.fn()}
        />
      )
    ).toContain('type="url"');
    expect(
      renderToStaticMarkup(
        <SchemaField
          name="status"
          fieldSchema={{ type: "string", enum: ["open", "closed"] }}
          value=""
          onChange={vi.fn()}
        />
      )
    ).toContain("<select");
    expect(
      renderToStaticMarkup(
        <SchemaField
          name="description"
          fieldSchema={{ type: "string" }}
          value=""
          onChange={vi.fn()}
        />
      )
    ).toContain("<textarea");
  });

  it("shows only essential person fields by default", () => {
    const html = renderEditor("/documents/new?dtype=person");
    expect(html).toContain("New Person");
    expect(html).toContain("Fields for person");
    expect(html).toContain("First Name");
    expect(html).toContain("Middle Name");
    expect(html).toContain("Last Name");
    expect(html).toContain("Add field");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Advanced");
    expect(html).not.toContain("Nationalities");
  });

  it("switches the field heading and fields for organizations", () => {
    const html = renderEditor("/documents/new?dtype=org");
    expect(html).toContain("New Organization");
    expect(html).toContain("Fields for org");
    expect(html).toContain("Legal Name");
    expect(html).toContain("Organization Type");
    expect(html).not.toContain("First Name");
  });

  it("keeps the complete editor full-screen with raw JSON access", () => {
    const html = renderEditor("/documents/new?dtype=person&advanced=1");
    expect(html).toContain("full-document-editor");
    expect(html).toContain("Full document editor.");
    expect(html).toContain("Inspect JSON");
    expect(html).toContain("Document metadata");
    expect(html).toContain("Sources and evidence");
  });
});
