import { mergeReviewActor, REVIEW_ACTOR_ID } from "./review-actor-pack";

const MELISSA_ACTOR_PREFIX = "quasar.actor.melissa-";

export function migrateActorSettings(settings) {
  if (Number(settings.quasarActorSettingsVersion || 0) >= 1) return settings;
  const actors = (settings.actors || []).filter(
    (actor) => !String(actor?.id || "").startsWith(MELISSA_ACTOR_PREFIX)
  );
  const hasReviewActor = actors.some((actor) => actor?.id === REVIEW_ACTOR_ID);
  return {
    ...settings,
    quasarActorSettingsVersion: 1,
    actors: hasReviewActor ? actors : mergeReviewActor(actors),
    ...(hasReviewActor ? {} : { actorsEnabled: true }),
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
