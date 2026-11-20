import { mergeReviewActor, REVIEW_ACTOR_ID } from "./review-actor-pack";

// Browser-actor authoring is removed. The only actor kept in settings is the
// shipped review-actor pack; user-authored manifests from the old editor are
// dropped by the v2 migration.
const SHIPPED_ACTOR_IDS = Object.freeze([REVIEW_ACTOR_ID]);

export function migrateActorSettings(settings) {
  const version = Number(settings.quasarActorSettingsVersion || 0);
  if (version >= 2) return settings;
  if (version < 1) {
    // First-time or legacy settings: install the review pack, nothing else.
    return {
      ...settings,
      quasarActorSettingsVersion: 2,
      actors: mergeReviewActor([]),
      melissaActorPackInstalled: false,
      melissaActorPackVersion: 0
    };
  }
  const actors = (settings.actors || []).filter((actor) =>
    SHIPPED_ACTOR_IDS.includes(String(actor?.id || ""))
  );
  return {
    ...settings,
    quasarActorSettingsVersion: 2,
    actors: mergeReviewActor(actors),
    melissaActorPackInstalled: false,
    melissaActorPackVersion: 0
  };
}

export async function initializeActorSettings(database) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let current;
    try {
      current = await database.get("settings");
    } catch (error) {
      if (error?.status !== 404) throw error;
      current = { _id: "settings" };
    }
    const migrated = migrateActorSettings(current);
    if (migrated === current) return current;
    try {
      const result = await database.put(migrated);
      return { ...migrated, _rev: result.rev };
    } catch (error) {
      if (error?.status !== 409 || attempt === 2) throw error;
      // Recompute only the default migrations from the latest document. Never
      // retry a stale actor array or whole-settings snapshot over a user edit.
    }
  }
}
