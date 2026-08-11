import { useEffect } from "react";
import { useQuasar } from "../store";

const MELISSA_ACTOR_PREFIX = "quasar.actor.melissa-";
const LEGACY_BROWSER_STORAGE_KEYS = Object.freeze([
  "quasar:melissa-actor-config:v1",
  "quasar:actor-configuration:v1"
]);

export default function MelissaActorMigrationBridge() {
  const { settings, persistSettings } = useQuasar();

  useEffect(() => {
    for (const key of LEGACY_BROWSER_STORAGE_KEYS) localStorage.removeItem(key);
  }, []);

  useEffect(() => {
    if (!settings) return;
    const actors = (settings.actors || []).filter(
      (actor) => !String(actor?.id || "").startsWith(MELISSA_ACTOR_PREFIX)
    );
    const hadMelissaActors = actors.length !== (settings.actors || []).length;
    const hadMelissaFlags =
      settings.melissaActorPackInstalled !== false ||
      Number(settings.melissaActorPackVersion || 0) !== 0;
    if (!hadMelissaActors && !hadMelissaFlags) return;
    persistSettings({
      actors,
      melissaActorPackInstalled: false,
      melissaActorPackVersion: 0
    }).catch(() => {});
  }, [persistSettings, settings]);

  return null;
}
