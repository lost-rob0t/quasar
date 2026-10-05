import { useEffect } from "react";

const LEGACY_BROWSER_STORAGE_KEYS = Object.freeze([
  "quasar:melissa-actor-config:v1",
  "quasar:actor-configuration:v1"
]);

export default function MelissaActorMigrationBridge() {
  useEffect(() => {
    for (const key of LEGACY_BROWSER_STORAGE_KEYS) localStorage.removeItem(key);
  }, []);

  return null;
}
