import { useEffect, useRef } from "react";
import { mergeReviewActor, REVIEW_ACTOR_ID } from "../lib/review-actor-pack";
import { useQuasar } from "../store";

export default function ReviewActorBridge() {
  const { settings, persistSettings, setNotice } = useQuasar();
  const installingRef = useRef(false);

  useEffect(() => {
    if (!settings || installingRef.current) return;
    const installed = (settings.actors || []).some((actor) => actor?.id === REVIEW_ACTOR_ID);
    if (installed) return;

    installingRef.current = true;
    persistSettings({
      actors: mergeReviewActor(settings.actors || []),
      actorsEnabled: true
    })
      .catch((error) => setNotice({ kind: "error", message: error.message }))
      .finally(() => {
        installingRef.current = false;
      });
  }, [persistSettings, setNotice, settings]);

  return null;
}
