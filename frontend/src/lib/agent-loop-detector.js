function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

export function fingerprint(value) {
  const source = JSON.stringify(stable(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function repeatedTail(values, size) {
  if (values.length < size) return false;
  const tail = values.slice(-size);
  return tail.every((value) => value === tail[0]);
}

function alternatingTail(values) {
  if (values.length < 6) return false;
  const tail = values.slice(-6);
  return (
    tail[0] === tail[2] &&
    tail[2] === tail[4] &&
    tail[1] === tail[3] &&
    tail[3] === tail[5] &&
    tail[0] !== tail[1]
  );
}

export function detectAgentLoop(history, limits = {}) {
  const maxActions = limits.maxRepeatedActions || 3;
  const maxResults = limits.maxRepeatedResults || 3;
  const calls = history.filter((entry) => entry.kind === "tool");
  const callFingerprints = calls.map((entry) =>
    fingerprint({ name: entry.name, arguments: entry.arguments })
  );
  const resultFingerprints = calls.map((entry) => fingerprint(entry.resultSummary));
  const errors = history
    .filter((entry) => entry.error)
    .map((entry) =>
      fingerprint({
        name: entry.name,
        code: entry.error.code,
        message: entry.error.message
      })
    );
  const messages = history
    .filter((entry) => entry.kind === "model")
    .map((entry) => fingerprint(entry.text));
  const stateFingerprints = history
    .filter((entry) => entry.stateFingerprint)
    .map((entry) => entry.stateFingerprint);

  if (repeatedTail(callFingerprints, maxActions))
    return event("identical-tool-call", calls, "Repeated identical tool calls");
  if (alternatingTail(callFingerprints))
    return event("alternating-actions", calls, "Alternating action cycle");
  if (repeatedTail(resultFingerprints, maxResults))
    return event("repeated-result", calls, "Repeated equivalent tool results");
  if (repeatedTail(errors, limits.maxConsecutiveFailures || 3))
    return event("repeated-error", history, "Repeated errors");
  if (repeatedTail(messages, 3))
    return event("repeated-message", history, "Repeated model messages");
  if (repeatedTail(stateFingerprints, limits.maxNoProgressIterations || 3))
    return event("no-progress", history, "No document or graph changes");
  return null;
}

function event(pattern, history, message) {
  return {
    pattern,
    message,
    detectedAt: new Date().toISOString(),
    relevantSteps: history.slice(-6).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      error: entry.error?.message || null
    })),
    suggestedActions: [
      "Edit instructions",
      "Restore checkpoint",
      "Use smaller context",
      "Kill loop"
    ]
  };
}
