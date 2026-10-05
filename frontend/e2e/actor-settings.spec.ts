import { expect, test } from "./fixtures";
import { expectCleanStartup, observeStartupErrors } from "./startup-evidence";

for (const existing of [false, true]) {
  test(`concurrent settings initialization preserves ${existing ? "existing user settings" : "fresh defaults"}`, async ({
    page
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (seedExisting) => {
      const dbModule = "/src/lib/db.js";
      const migrationModule = "/src/lib/actor-settings.js";
      const { stateDb } = await import(/* @vite-ignore */ dbModule);
      const { initializeActorSettings } = await import(/* @vite-ignore */ migrationModule);
      const name = `actor-race-${crypto.randomUUID()}`;
      const first = new stateDb.constructor(name);
      const second = new stateDb.constructor(name);
      try {
        if (seedExisting) {
          await first.put({
            _id: "settings",
            theme: "light",
            serverUrl: "https://example.test",
            actors: [{ id: "custom" }, { id: "quasar.actor.melissa-old" }],
            melissaActorPackInstalled: true
          });
        }
        let reads = 0;
        let release!: () => void;
        const bothRead = new Promise<void>((resolve) => (release = resolve));
        const synchronize = (database: typeof first) => ({
          async get(id: string) {
            if (reads >= 2) return database.get(id);
            let current;
            let failure;
            try {
              current = await database.get(id);
            } catch (error) {
              failure = error;
            }
            if (++reads === 2) release();
            await bothRead;
            if (failure) throw failure;
            return current;
          },
          put: (document: object) => database.put(document)
        });
        const outcomes = await Promise.allSettled([
          initializeActorSettings(synchronize(first)),
          initializeActorSettings(synchronize(second))
        ]);
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const saved = await first.get("settings");
        await initializeActorSettings(second);
        return { saved, repeated: await first.get("settings") };
      } finally {
        await first.destroy();
      }
    }, existing);
    expect(result.saved).toMatchObject({
      melissaActorPackInstalled: false,
      melissaActorPackVersion: 0,
      actorsEnabled: true
    });
    expect(result.saved.actors.map((actor: { id: string }) => actor.id)).toEqual(
      existing ? ["custom", "quasar.actor.mark-reviewed"] : ["quasar.actor.mark-reviewed"]
    );
    if (existing) {
      expect(result.saved.theme).toBe("light");
      expect(result.saved.serverUrl).toBe("https://example.test");
    }
    expect(result.repeated).toEqual(result.saved);
  });
}

test("settings migration rebases on a real conflicting user edit", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const dbModule = "/src/lib/db.js";
    const migrationModule = "/src/lib/actor-settings.js";
    const { stateDb } = await import(/* @vite-ignore */ dbModule);
    const { initializeActorSettings } = await import(/* @vite-ignore */ migrationModule);
    const database = new stateDb.constructor(`actor-user-edit-${crypto.randomUUID()}`);
    let puts = 0;
    try {
      await database.put({ _id: "settings", actors: [], theme: "midnight" });
      await initializeActorSettings({
        get: (id: string) => database.get(id),
        async put(document: object) {
          if (++puts === 1) {
            const current = await database.get("settings");
            await database.put({
              ...current,
              theme: "light",
              actorsEnabled: false,
              actors: [
                { id: "new-custom", source: "user source" },
                { id: "quasar.actor.mark-reviewed", source: "user review" }
              ]
            });
          }
          return database.put(document);
        }
      });
      return { saved: await database.get("settings"), puts };
    } finally {
      await database.destroy();
    }
  });
  expect(result.puts).toBe(2);
  expect(result.saved).toMatchObject({
    theme: "light",
    actorsEnabled: false,
    actors: [
      { id: "new-custom", source: "user source" },
      { id: "quasar.actor.mark-reviewed", source: "user review" }
    ],
    melissaActorPackInstalled: false
  });
});

test("real startup composes actor migrations and preserves persisted user configuration", async ({
  page
}) => {
  await observeStartupErrors(page);
  await page.goto("/");
  await expectCleanStartup(page);
  await page.evaluate(async () => {
    const dbModule = "/src/lib/db.js";
    const { stateDb } = await import(/* @vite-ignore */ dbModule);
    const current = await stateDb.get("settings");
    await stateDb.put({
      ...current,
      theme: "midnight",
      customPreference: "preserve me",
      quasarActorSettingsVersion: 0,
      actorsEnabled: false,
      actors: [
        { id: "quasar.actor.melissa-obsolete" },
        { id: "custom", source: "custom source" },
        { id: "quasar.actor.mark-reviewed", source: "edited review" }
      ],
      melissaActorPackInstalled: true,
      melissaActorPackVersion: 1
    });
  });
  await page.reload();
  await expectCleanStartup(page);
  const saved = await page.evaluate(async () => {
    const dbModule = "/src/lib/db.js";
    const { stateDb } = await import(/* @vite-ignore */ dbModule);
    return stateDb.get("settings");
  });
  expect(saved).toMatchObject({
    customPreference: "preserve me",
    actorsEnabled: false,
    actors: [
      { id: "custom", source: "custom source" },
      { id: "quasar.actor.mark-reviewed", source: "edited review" }
    ],
    melissaActorPackInstalled: false,
    melissaActorPackVersion: 0
  });
});

test("removing the default review actor survives a settings save and restart", async ({ page }) => {
  await observeStartupErrors(page);
  await page.goto("/settings");
  await expectCleanStartup(page);
  const review = page.locator(".actor-row").filter({ hasText: "quasar.actor.mark-reviewed" });
  await expect(review).toHaveCount(1);
  await review.getByRole("button").click();
  await page.getByLabel("Enable actor execution").uncheck();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.locator(".notice-success")).toContainText("Settings saved");
  await page.reload();
  await expectCleanStartup(page);
  await expect(review).toHaveCount(0);
  await expect(page.getByLabel("Enable actor execution")).not.toBeChecked();
  const stored = await page.evaluate(async () => {
    const dbModule = "/src/lib/db.js";
    const { stateDb } = await import(/* @vite-ignore */ dbModule);
    return stateDb.get("settings");
  });
  expect(stored.quasarActorSettingsVersion).toBe(1);
  expect(stored.actorsEnabled).toBe(false);
  expect(
    stored.actors.some((actor: { id: string }) => actor.id === "quasar.actor.mark-reviewed")
  ).toBe(false);
});
