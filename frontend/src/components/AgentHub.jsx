import { Navigate, useSearchParams } from "react-router-dom";
import { AgentConsole } from "./AgentSystem";

export default function AgentHub() {
  const [searchParams] = useSearchParams();

  if (searchParams.get("section") === "actors") {
    return <Navigate to="/actors" replace />;
  }

  return <AgentConsole />;
}
