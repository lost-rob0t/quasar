import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSearchQuery } from "../lib/route-query-cache";
import { DocumentsPage, documentsRouteCache } from "./Documents";

vi.mock("../store", () => ({
  useQuasar: () => ({
    documents: [],
    execute: vi.fn(),
    setNotice: vi.fn(),
    createGraph: vi.fn(),
    addDocumentsToActiveGraph: vi.fn(),
    cpClient: null
  })
}));

function searchRow(id) {
  return { id, dtype: "person", dataset: "test", schemaVersion: "0.10.1" };
}

function seedClient(rows) {
  return {
    async documentSearch(request) {
      expect(request.limit).toBe(50);
      return { documents: rows, complete: true, cursor: null, projection: "search-row.v1" };
    },
    async documentBatch(ids) {
      return {
        documents: ids.map((id) => ({ ...searchRow(id) })),
        missingIds: []
      };
    }
  };
}

async function seedBoundedPage(query, rows) {
  const client = seedClient(rows);
  await documentsRouteCache.getPage(client, query, 1);
  await documentsRouteCache.getDocuments(client, query, 1);
}

function renderPage(entry) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <DocumentsPage />
    </MemoryRouter>
  );
}

describe("bounded documents page", () => {
  beforeEach(() => {
    documentsRouteCache.invalidate();
  });

  it("renders a cached search page with bounded result counts", async () => {
    await seedBoundedPage(normalizeSearchQuery({ q: "ada" }), [
      searchRow("p1"),
      searchRow("p2"),
      searchRow("p3")
    ]);

    const html = renderPage("/documents?q=ada");
    expect(html).toContain(">p1<");
    expect(html).toContain("dtype dtype-person");
    expect(html).toContain("3");
    expect(html).toContain("Workspace 1–3 of 3");
    expect(html).toContain("Workspace page 1 of 1");
    // A complete scope does not advertise more pages.
    expect(html).not.toContain("more pages available");
    expect(html).not.toContain("more results");
  });

  it("renders projection rows when canonical batch data is unavailable", async () => {
    const query = normalizeSearchQuery({ q: "ada" });
    const client = {
      async documentSearch() {
        return { documents: [searchRow("only-row")], complete: true, cursor: null };
      }
    };
    await documentsRouteCache.getPage(client, query, 1);
    // No documentBatch call: the page renders from the search projection.

    const html = renderPage("/documents?q=ada");
    expect(html).toContain(">only-row<");
    expect(html).toContain("dtype dtype-person");
  });

  it("describes an empty, unfetched corpus without claiming a failed filter", () => {
    const html = renderPage("/documents");
    expect(html).toContain("No documents loaded yet.");
    expect(html).toContain("Showing 0 workspace documents");
  });

  it("distinguishes a filtered empty scope from an empty corpus", async () => {
    await seedBoundedPage(normalizeSearchQuery({ q: "nomatch" }), []);
    const html = renderPage("/documents?q=nomatch");
    expect(html).toContain("No documents match these filters.");
  });

  it("renders one merged search surface without source tabs", () => {
    const html = renderPage("/documents");
    expect(html).not.toContain("Live ingest");
    expect(html).toContain("One searchable view of the workspace corpus and the live server ingest.");
    expect(html).toContain("in workspace");
    expect(html).toContain("All datasets");
  });
});
