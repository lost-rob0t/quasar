import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ current: null }));
vi.mock("../store", () => ({ useQuasar: () => context.current }));
vi.mock("../lib/operations", () => ({ operation: {} }));

import { CompactNodeEditor, CompactRelationEditor } from "./GraphEditors";

const person = {
  _id: "starintel:person:alice",
  dataset: "test",
  dtype: "person",
  title: "Alice",
  data: { fname: "Alice", lname: "Example", aliases: [] },
  sources: []
};
const org = {
  _id: "starintel:org:example",
  dataset: "test",
  dtype: "org",
  title: "Example Org",
  data: { name: "Example Org" },
  sources: []
};

function render(element) {
  context.current = {
    documents: [person, org],
    execute: vi.fn(),
    setNotice: vi.fn(),
    addDocumentsToActiveGraph: vi.fn(),
    workspace: { positions: {} }
  };
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

describe("compact graph editors", () => {
  it("renders a compact schema-driven person editor", () => {
    const html = render(<CompactNodeEditor document={person} onClose={vi.fn()} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Edit Person");
    expect(html).toContain("Fields for person");
    expect(html).toContain("First Name");
    expect(html).toContain("string · optional");
    expect(html).toContain("Add field");
    expect(html).toContain("Inspect JSON");
    expect(html).toContain("Generate empty document");
    expect(html).toContain("Open full editor");
    expect(html).toContain("Delete");
    expect(html).toContain("Cancel");
    expect(html).toContain("Save");
  });

  it("renders a compact create editor without replacing the full editor", () => {
    const html = render(<CompactNodeEditor objectType="org" dataset="test" onClose={vi.fn()} />);
    expect(html).toContain("New Organization");
    expect(html).toContain("Fields for org");
    expect(html).toContain("Open full editor");
    expect(html).not.toContain("Delete");
  });

  it("prepopulates dragged relation endpoints", () => {
    const html = render(
      <CompactRelationEditor
        ids={[person._id, org._id]}
        documents={[person, org]}
        position={{ rendered: { x: 20, y: 30 }, bounds: { width: 800, height: 600 } }}
        onClose={vi.fn()}
      />
    );
    expect(html).toContain("New relation");
    expect(html).toContain("Alice");
    expect(html).toContain("Example Org");
    expect(html).toContain("Predicate");
    expect(html).toContain("person → org");
    expect(html).toContain("Start Date");
    expect(html).toContain("End Date");
    expect(html).toContain("Reverse relation");
    expect(html).toContain("Inspect JSON");
    expect(html).toContain("Generate empty document");
    expect(html).toContain("Add field");
    expect(html).toContain("Open full editor");
    expect(html).not.toContain("Select document");
  });

  it("renders searchable document selectors when endpoints are not fixed", () => {
    const html = render(<CompactRelationEditor documents={[person, org]} onClose={vi.fn()} />);
    expect(html).toContain("Select document");
    expect(html).toContain("document reference · required");
    expect(html).toContain('aria-expanded="false"');
  });
});
