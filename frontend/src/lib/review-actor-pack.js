export const REVIEW_ACTOR_ID = "quasar.actor.mark-reviewed";

export function markReviewedActor(context) {
  const selection = Array.isArray(context.selection) ? context.selection.slice(0, 32) : [];
  const stamp = new Date().toISOString();

  return {
    operations: selection.map((source) => ({
      op: "update_document",
      document: {
        ...source,
        version: Number(source.version || 0) + 1,
        date_updated: stamp,
        verification: {
          ...(source.verification || {}),
          verified: true,
          status: "reviewed"
        },
        extensions: {
          ...(source.extensions || {}),
          "quasar.actor": {
            actor_id: "quasar.actor.mark-reviewed",
            input_ids: [source._id]
          }
        }
      }
    })),
    message: `Marked ${selection.length} document(s) reviewed.`
  };
}

export const REVIEW_ACTOR = Object.freeze({
  id: REVIEW_ACTOR_ID,
  label: "Mark reviewed",
  description: "Mark the selected graph documents as reviewed.",
  version: 1,
  accepts: ["*"],
  triggers: [],
  runtime: "quasar.browser-js.v1",
  capabilities: [],
  minSelection: 1,
  maxSelection: 32,
  source: markReviewedActor.toString(),
  manualOnly: true,
  pack: "review"
});

export function mergeReviewActor(actors = []) {
  return [...(actors || []).filter((actor) => actor?.id !== REVIEW_ACTOR_ID), REVIEW_ACTOR];
}

export function removeReviewActor(actors = []) {
  return (actors || []).filter((actor) => actor?.id !== REVIEW_ACTOR_ID);
}
