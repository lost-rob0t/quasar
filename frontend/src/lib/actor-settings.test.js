import { expect, it, vi } from "vitest";
import { initializeActorSettings, migrateActorSettings } from "./actor-settings";
import { REVIEW_ACTOR_ID } from "./review-actor-pack";

it("v2 migration keeps only shipped actors and drops user-authored ones", () => {
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
  expect(migrated.quasarActorSettingsVersion).toBe(2);
  expect(migrated.actors.map((actor) => actor.id)).toEqual([REVIEW_ACTOR_ID]);
  expect(migrated.melissaActorPackInstalled).toBe(false);
  expect(migrated.melissaActorPackVersion).toBe(0);
  expect(migrated.theme).toBe("light");
  expect(migrateActorSettings(migrated)).toBe(migrated);
  expect(settings.actors).toHaveLength(3);
});

it("installs the review pack for legacy settings that never migrated", () => {
  const migrated = migrateActorSettings({ theme: "midnight" });
  expect(migrated.quasarActorSettingsVersion).toBe(2);
  expect(migrated.actors.map((actor) => actor.id)).toEqual([REVIEW_ACTOR_ID]);
});

it("rebases the migration on conflicting user changes instead of replaying stale settings", async () => {
  const userEdit = {
    _id: "settings",
    _rev: "2-user",
    theme: "light",
    actors: [{ id: "leftover-custom" }],
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
  expect(result.actors.map((actor) => actor.id)).toEqual([REVIEW_ACTOR_ID]);
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

it("leaves current-version settings untouched, including intentional removal", () => {
  const removed = {
    _id: "settings",
    _rev: "3-user",
    quasarActorSettingsVersion: 2,
    actors: []
  };
  expect(migrateActorSettings(removed)).toBe(removed);
});

it("does not downgrade a newer migration marker", () => {
  const current = { quasarActorSettingsVersion: 3, actors: [] };
  expect(migrateActorSettings(current)).toBe(current);
});
