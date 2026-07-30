export function agentChatSearchText(run) {
  return [
    run?.goal,
    run?.id,
    run?.status,
    run?.statusReason,
    run?.agentId,
    run?.dataset,
    run?.graphId
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterAgentChats(runs, query) {
  const terms = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [...(runs || [])];
  return (runs || []).filter((run) => {
    const text = agentChatSearchText(run);
    return terms.every((term) => text.includes(term));
  });
}
