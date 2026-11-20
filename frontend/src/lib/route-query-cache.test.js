import { describe, expect, it } from "vitest";
import { createRouteQueryCache, normalizeSearchQuery, searchQueryKey } from "./route-query-cache";

function row(id) {
  return { id, dtype: "person", dataset: "test", schemaVersion: "0.10.1" };
}

function wireError(code) {
  return Object.assign(new Error(code), { code });
}

function pagedClient(pages, { failOnCursor = null, staleOnce = null } = {}) {
  const searches = [];
  const batches = [];
  let staledOnce = false;
  return {
    searches,
    batches,
    async documentSearch(request) {
      searches.push({ ...request });
      if (request.cursor === staleOnce && !staledOnce) {
        staledOnce = true;
        throw wireError("query.stale-cursor");
      }
      if (failOnCursor && request.cursor === failOnCursor) throw wireError("query.stale-cursor");
      const index = request.cursor ? Number(request.cursor) : 0;
      const page = pages[index];
      if (!page) throw wireError("query.invalid-cursor");
      return {
        documents: page.rows,
        complete: page.complete,
        cursor: page.cursor || null,
        revision: 1,
        projection: "search-row.v1"
      };
    },
    async documentBatch(ids) {
      batches.push([...ids]);
      const documents = [...ids].reverse().map((id) => ({ ...row(id), title: `Doc ${id}` }));
      return { documents, missingIds: [] };
    }
  };
}

describe("normalizeSearchQuery", () => {
  it("drops empty filters and clamps the page size", () => {
    expect(normalizeSearchQuery({})).toEqual({ filters: {}, limit: 50 });
    expect(normalizeSearchQuery({ q: "  ", dtype: "", dataset: "" })).toEqual({
      filters: {},
      limit: 50
    });
    expect(
      normalizeSearchQuery({ q: "ada", dtype: "person", dataset: "ops", perPage: 999 })
    ).toEqual({ filters: { q: "ada", dtype: "person", datasets: ["ops"] }, limit: 250 });
  });

  it("keys queries independently of property order", () => {
    const left = { filters: { dtype: "person", q: "ada" }, limit: 50 };
    const right = { filters: { q: "ada", dtype: "person" }, limit: 50 };
    expect(searchQueryKey(left)).toBe(searchQueryKey(right));
    expect(searchQueryKey(left)).not.toBe(searchQueryKey({ ...left, limit: 100 }));
  });
});

describe("route query cache paging", () => {
  const query = normalizeSearchQuery({ q: "ada" });

  it("fetches one page at a time and chains cursors from page 1", async () => {
    const client = pagedClient([
      { rows: [row("p1"), row("p2")], cursor: "1", complete: false },
      { rows: [row("p3")], complete: true }
    ]);
    const cache = createRouteQueryCache();

    const first = await cache.getPage(client, query, 1);
    expect(first.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(first.complete).toBe(false);
    expect(client.searches).toEqual([{ q: "ada", limit: 50 }]);

    const second = await cache.getPage(client, query, 2);
    expect(second.rows.map((r) => r.id)).toEqual(["p3"]);
    expect(second.complete).toBe(true);
    expect(client.searches[1]).toEqual({ q: "ada", limit: 50, cursor: "1" });

    // Cached pages are not refetched.
    await cache.getPage(client, query, 1);
    expect(client.searches).toHaveLength(2);
    expect(cache.totals(query)).toEqual({ known: 3, complete: true, pages: 2 });
  });

  it("never stores the same scope twice under concurrent getPage calls", async () => {
    // Regression: two overlapping effect runs (param churn) both saw an
    // empty cache and fetched page 1; the second stored its identical scope
    // as page 2, inflating totals to duplicate counts and rendering a
    // phantom page that re-rendered page 1 rows.
    const client = pagedClient([{ rows: [row("p1"), row("p2")], complete: true }]);
    const cache = createRouteQueryCache();
    const query2 = { filters: { q: "ada" }, limit: 50 };

    const [first, second, third] = await Promise.all([
      cache.getPage(client, query2, 1),
      cache.getPage(client, query2, 1),
      cache.getPage(client, query2, 1)
    ]);

    expect(client.searches).toHaveLength(1);
    expect(first.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(second.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(third.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(cache.totals(query2)).toEqual({ known: 2, complete: true, pages: 1 });
  });

  it("serializes queued callers racing for the next page", async () => {
    const client = pagedClient([
      { rows: [row("p1")], cursor: "1", complete: false },
      { rows: [row("p2")], complete: true }
    ]);
    const cache = createRouteQueryCache();
    const query2 = { filters: { q: "ada" }, limit: 50 };

    // Seed page 1 first: the documents route clamps targets to chain + 1,
    // so page-2 callers only race once page 1 exists.
    await cache.getPage(client, query2, 1);
    const [one, two] = await Promise.all([
      cache.getPage(client, query2, 2),
      cache.getPage(client, query2, 2)
    ]);

    expect(one?.pageNumber).toBe(2);
    expect(two?.pageNumber).toBe(2);
    expect(two.rows.map((r) => r.id)).toEqual(["p2"]);
    expect(client.searches).toHaveLength(2);
    expect(cache.totals(query2)).toEqual({ known: 2, complete: true, pages: 2 });
  });

  it("returns null past a complete scope instead of draining", async () => {
    const client = pagedClient([{ rows: [row("p1")], complete: true }]);
    const cache = createRouteQueryCache();
    await cache.getPage(client, query, 1);
    expect(await cache.getPage(client, query, 2)).toBeNull();
    expect(client.searches).toHaveLength(1);
  });

  it("restarts from page 1 once on a stale cursor", async () => {
    const client = pagedClient(
      [
        { rows: [row("p1")], cursor: "1", complete: false },
        { rows: [row("p2")], complete: true }
      ],
      { staleOnce: "1" }
    );
    const cache = createRouteQueryCache();
    await cache.getPage(client, query, 1);

    const second = await cache.getPage(client, query, 2);
    expect(second.rows.map((r) => r.id)).toEqual(["p2"]);
    // Page 1 was refetched without a cursor after the restart.
    expect(client.searches[2]).toEqual({ q: "ada", limit: 50 });
  });

  it("propagates a cursor failure that survives one restart", async () => {
    const client = pagedClient(
      [
        { rows: [row("p1")], cursor: "1", complete: false },
        { rows: [row("p2")], complete: true }
      ],
      { failOnCursor: "1" }
    );
    const cache = createRouteQueryCache();
    // First fetch never supplies a cursor, so it succeeds; every attempt to
    // reach page 2 restarts at page 1 and fails again.
    await cache.getPage(client, query, 1);
    await expect(cache.getPage(client, query, 2)).rejects.toMatchObject({
      code: "query.stale-cursor"
    });
  });

  it("serves a freshly fetched page even when budgets trim it", async () => {
    const client = pagedClient([
      { rows: [row("p1"), row("p2")], cursor: "1", complete: false },
      { rows: [row("p3"), row("p4")], cursor: "2", complete: false },
      { rows: [row("p5"), row("p6")], complete: true }
    ]);
    const cache = createRouteQueryCache({ maxRecordsPerQuery: 2, maxBytesPerQuery: 1 << 20 });

    const third = await cache.getPage(client, query, 3);
    expect(third.rows.map((r) => r.id)).toEqual(["p5", "p6"]);
    // Only page 1 fits the record budget.
    expect(cache.totals(query)).toEqual({ known: 2, complete: true, pages: 1 });
  });

  it("evicts whole queries LRU beyond maxQueries", async () => {
    const client = pagedClient([{ rows: [row("p1")], complete: true }]);
    const cache = createRouteQueryCache({ maxQueries: 2 });
    const one = normalizeSearchQuery({ q: "one" });
    const two = normalizeSearchQuery({ q: "two" });
    const three = normalizeSearchQuery({ q: "three" });

    await cache.getPage(client, one, 1);
    await cache.getPage(client, two, 1);
    await cache.getPage(client, three, 1);

    expect(cache.totals(one).pages).toBe(0);
    expect(cache.totals(two).pages).toBe(1);
    expect(cache.totals(three).pages).toBe(1);
  });

  it("invalidate clears every entry", async () => {
    const client = pagedClient([{ rows: [row("p1")], complete: true }]);
    const cache = createRouteQueryCache();
    await cache.getPage(client, query, 1);
    cache.invalidate();
    expect(cache.totals(query)).toEqual({ known: 0, complete: false, pages: 0 });
  });
});

describe("route query cache canonical batches", () => {
  it("batches page ids in search order and caches the result", async () => {
    const client = pagedClient([{ rows: [row("p1"), row("p2"), row("p3")], complete: true }]);
    const query = normalizeSearchQuery({ q: "ada" });
    const cache = createRouteQueryCache();
    await cache.getPage(client, query, 1);

    const page = await cache.getDocuments(client, query, 1);
    // documentBatch returns documents reversed; the cache restores search order.
    expect(page.documents.map((document) => document.id)).toEqual(["p1", "p2", "p3"]);
    expect(client.batches).toEqual([["p1", "p2", "p3"]]);

    await cache.getDocuments(client, query, 1);
    expect(client.batches).toHaveLength(1);

    expect(cache.peekDocuments(query, 1)).toBe(page);
    expect(cache.peekDocuments(query, 2)).toBeNull();
  });

  it("returns null for unknown pages and empty arrays for empty rows", async () => {
    const client = pagedClient([{ rows: [], complete: true }]);
    const query = normalizeSearchQuery({});
    const cache = createRouteQueryCache();
    await cache.getPage(client, query, 1);

    expect(await cache.getDocuments(client, query, 2)).toBeNull();
    const page = await cache.getDocuments(client, query, 1);
    expect(page.documents).toEqual([]);
    expect(page.missingIds).toEqual([]);
    expect(client.batches).toHaveLength(0);
  });
});
