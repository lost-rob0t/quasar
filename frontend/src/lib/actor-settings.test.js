import { expect, it, vi } from "vitest";
import { initializeActorSettings, migrateActorSettings } from "./actor-settings";
import { REVIEW_ACTOR_ID } from "./review-actor-pack";

it("composes both migrations while preserving user settings and actor definitions", () => {
  const review = { id: REVIEW_ACTOR_ID, source: "user-edited", label: "My review" };
  const custom = { id: "custom", source: "custom source" };
  const settings = {
    _id: "settings",
    _rev: "1-user",
    theme: "light",
    serverUrl: "https://example.test",
    actorsEnabled: false,
    actors: [{ id: "quasar.actor.melissa-old" }, review, custom],
    melissaActorPackInstalled: true,
    melissaActorPackVersion: 1
  };
  const migrated = migrateActorSettings(settings);
  expect(migrated).toEqual({
    ...settings,
    quasarActorSettingsVersion: 1,
    actors: [review, custom],
    melissaActorPackInstalled: false,
    melissaActorPackVersion: 0
  });
  expect(migrateActorSettings(migrated)).toBe(migrated);
  expect(settings.actors).toHaveLength(3);
});

it("rebases the migration on conflicting user changes instead of replaying stale settings", async () => {
  const userEdit = {
    _id: "settings",
    _rev: "2-user",
    theme: "light",
    actors: [{ id: "new-custom" }],
    serverUrl: "https://new.example.test"
  };
  const database = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ _id: "settings", _rev: "1-old", theme: "midnight", actors: [] })
      .mockResolvedValue(userEdit),
    put: vi.fn().mockRejectedValueOnce({ status: 409 }).mockResolvedValue({ rev: "3-migrated" })
  };
  const result = await initializeActorSettings(database);
  expect(database.put.mock.calls[1][0]).toMatchObject({ ...userEdit, actors: expect.any(Array) });
  expect(result.actors.map((actor) => actor.id)).toEqual(["new-custom", REVIEW_ACTOR_ID]);
  expect(result.theme).toBe("light");
});

it("bounds persistent conflicts and reports the actual final error", async () => {
  const error = Object.assign(new Error("conflicting writer"), { status: 409 });
  const database = {
    get: vi.fn().mockResolvedValue({ _id: "settings" }),
    put: vi.fn().mockRejectedValue(error)
  };
  await expect(initializeActorSettings(database)).rejects.toBe(error);
  expect(database.put).toHaveBeenCalledTimes(3);
});

it("does not suppress genuine storage failures", async () => {
  const error = Object.assign(new Error("storage unavailable"), { status: 503 });
  const database = {
    get: vi.fn().mockRejectedValueOnce({ status: 404 }),
    put: vi.fn().mockRejectedValue(error)
  };
  await expect(initializeActorSettings(database)).rejects.toBe(error);
  expect(database.put).toHaveBeenCalledTimes(1);
});

it("preserves intentional actor removal and disabled execution after migration", async () => {
  const removed = {
    _id: "settings",
    _rev: "3-user",
    quasarActorSettingsVersion: 1,
    actors: [],
    actorsEnabled: false
  };
  const database = { get: vi.fn().mockResolvedValue(removed), put: vi.fn() };
  expect(migrateActorSettings(removed)).toBe(removed);
  await expect(initializeActorSettings(database)).resolves.toBe(removed);
  expect(database.put).not.toHaveBeenCalled();
});

it("does not downgrade a newer migration marker", () => {
  const current = { quasarActorSettingsVersion: 2, actors: [] };
  expect(migrateActorSettings(current)).toBe(current);
});
