import { expect, test } from "./fixtures";

for (const existing of [false, true]) {
  test(`concurrent view installation is idempotent with ${existing ? "outdated" : "missing"} designs`, async ({
    page
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (seedExisting) => {
      const dbModule = "/src/lib/db.js";
      const viewsModule = "/src/lib/views.js";
      const { documentsDb } = await import(/* @vite-ignore */ dbModule);
      const { installStarIntelViews, STARINTEL_VIEW_MANIFEST } = await import(
        /* @vite-ignore */ viewsModule
      );
      const PouchDB = documentsDb.constructor;
      const name = `view-race-${crypto.randomUUID()}`;
      const first = new PouchDB(name);
      const second = new PouchDB(name);
      const entry = STARINTEL_VIEW_MANIFEST[0];
      try {
        if (seedExisting) {
          await first.put({ _id: entry.id, views: {}, quasar_view_version: "outdated" });
        }
        await first.put({ _id: "_design/unrelated", views: {}, owner: "someone else" });
        const unrelated = await first.get("_design/unrelated");
        let reads = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => (release = resolve));
        // Only synchronize real reads. PouchDB's IndexedDB adapter decides which
        // genuine put wins and returns the real 409 to the losing initializer.
        const synchronize = (database: typeof first) => ({
          async get(id: string) {
            if (id !== entry.id || reads >= 2) return database.get(id);
            let document;
            let failure;
            try {
              document = await database.get(id);
            } catch (error) {
              failure = error;
            }
            if (++reads === 2) release();
            await bothRead;
            if (failure) throw failure;
            return document;
          },
          put: (document: object) => database.put(document)
        });
        const outcomes = await Promise.allSettled([
          installStarIntelViews(synchronize(first)),
          installStarIntelViews(synchronize(second))
        ]);
        const before = await first.allDocs({ include_docs: true });
        const repeat = await installStarIntelViews(first);
        const after = await first.allDocs({ include_docs: true });
        return {
          adapter: (await first.info()).adapter,
          outcomes: outcomes.map((outcome) =>
            outcome.status === "fulfilled"
              ? { status: outcome.status }
              : { status: outcome.status, error: String(outcome.reason) }
          ),
          unchanged: JSON.stringify(before) === JSON.stringify(after),
          repeatCurrent: repeat.every((item: { status: string }) => item.status === "current"),
          unrelatedUnchanged:
            JSON.stringify(unrelated) === JSON.stringify(await first.get("_design/unrelated")),
          installed: await Promise.all(
            STARINTEL_VIEW_MANIFEST.map(async (definition: typeof entry) => {
              const saved = await first.get(definition.id);
              return (
                saved.quasar_view_version === definition.version &&
                JSON.stringify(saved.views) === JSON.stringify(definition.views)
              );
            })
          )
        };
      } finally {
        await first.destroy();
      }
    }, existing);
    expect(result.adapter).toBe("idb");
    expect(result.outcomes).toEqual([{ status: "fulfilled" }, { status: "fulfilled" }]);
    expect(result.unchanged).toBe(true);
    expect(result.repeatCurrent).toBe(true);
    expect(result.unrelatedUnchanged).toBe(true);
    expect(result.installed.every(Boolean)).toBe(true);
  });
}
