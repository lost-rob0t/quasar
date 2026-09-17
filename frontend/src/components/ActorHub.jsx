import ActorManager from "./ActorManager";
import ProActorManager from "./ProActorManager";

export default function ActorHub() {
  return (
    <div className="actor-hub">
      <ProActorManager />
      <ActorManager />
    </div>
  );
}
