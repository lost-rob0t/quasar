import {
  MELISSA_ACTORS,
  MELISSA_ACTOR_PACK_VERSION,
  mergeMelissaActors
} from "./melissa-actor-pack-runtime";

export function installMelissaActorPack(settings = {}) {
  return {
    actors: mergeMelissaActors(settings.actors || []),
    actorsEnabled: true,
    melissaActorPackInstalled: true,
    melissaActorPackVersion: MELISSA_ACTOR_PACK_VERSION
  };
}

export { MELISSA_ACTORS, MELISSA_ACTOR_PACK_VERSION };
