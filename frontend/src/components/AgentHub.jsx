import { Bot, Code2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import ActorManager from "./ActorManager";
import { AgentConsole } from "./AgentSystem";

export default function AgentHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const section = searchParams.get("section") === "actors" ? "actors" : "agents";

  return (
    <>
      <nav className="agent-hub-menu" aria-label="Agent workspace">
        <button
          type="button"
          className={section === "agents" ? "active" : ""}
          onClick={() => setSearchParams({ tab: searchParams.get("tab") || "run" })}
        >
          <Bot size={16} /> Agents
        </button>
        <button
          type="button"
          className={section === "actors" ? "active" : ""}
          onClick={() => setSearchParams({ section: "actors" })}
        >
          <Code2 size={16} /> Actors
        </button>
      </nav>
      {section === "actors" ? <ActorManager /> : <AgentConsole />}
    </>
  );
}
