export function zeroUsage() {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    toolCalls: 0,
    iterations: 0,
    runtimeMs: 0
  };
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return number;
}

function configuredLimit(policy, key) {
  const value = policy?.[key];
  if (value === undefined || value === null || value === "") return null;
  return finiteNonNegative(value, key);
}

export function addUsage(current, delta) {
  const result = { ...zeroUsage(), ...(current || {}) };
  for (const key of Object.keys(result)) {
    result[key] =
      finiteNonNegative(result[key], `Usage ${key}`) +
      finiteNonNegative(delta?.[key] || 0, `Usage delta ${key}`);
  }
  return result;
}

export function calculateCost(usage, pricing) {
  const inputTokens = finiteNonNegative(usage?.inputTokens || 0, "Input tokens");
  const cachedTokens = finiteNonNegative(usage?.cachedTokens || 0, "Cached tokens");
  const outputTokens = finiteNonNegative(usage?.outputTokens || 0, "Output tokens");
  const billableInput = Math.max(0, inputTokens - cachedTokens);

  if (pricing?.free === true) return 0;

  const inputRate = Number(pricing?.inputPerMillionUsd);
  const outputRate = Number(pricing?.outputPerMillionUsd);
  const cachedRate = Number(pricing?.cachedInputPerMillionUsd ?? pricing?.inputPerMillionUsd);
  const hasUsage = billableInput > 0 || cachedTokens > 0 || outputTokens > 0;
  const ratesKnown = [inputRate, outputRate, cachedRate].every(
    (rate) => Number.isFinite(rate) && rate >= 0
  );

  if (hasUsage && !ratesKnown) {
    throw new Error("Model pricing is required before a cost-budgeted run can continue");
  }

  if (hasUsage && inputRate === 0 && outputRate === 0 && cachedRate === 0) {
    throw new Error("Zero model pricing must be marked explicitly with free: true");
  }

  return (
    (billableInput / 1_000_000) * (inputRate || 0) +
    (cachedTokens / 1_000_000) * (cachedRate || 0) +
    (outputTokens / 1_000_000) * (outputRate || 0)
  );
}

export function budgetState(policy, usage, projected = {}) {
  const next = addUsage(usage, projected);
  const limits = [
    ["costUsd", "maxCostUsd", "Run cost"],
    ["inputTokens", "maxInputTokens", "Input tokens"],
    ["outputTokens", "maxOutputTokens", "Output tokens"],
    ["toolCalls", "maxToolCalls", "Tool calls"],
    ["iterations", "maxIterations", "Iterations"],
    ["runtimeMs", "maxRuntimeMs", "Runtime"]
  ];
  let highestRatio = 0;

  for (const [usageKey, policyKey, label] of limits) {
    const limit = configuredLimit(policy, policyKey);
    if (limit === null) continue;
    if (limit === 0) {
      return { state: "hard-stop", reason: `${label} limit reached`, ratio: 1, usage: next };
    }

    const ratio = finiteNonNegative(next[usageKey] || 0, `Usage ${usageKey}`) / limit;
    highestRatio = Math.max(highestRatio, ratio);
    if (ratio >= 1)
      return { state: "hard-stop", reason: `${label} limit reached`, ratio, usage: next };
  }

  const softLimit = finiteNonNegative(policy?.softLimitRatio ?? 0.8, "Soft limit ratio");
  if (highestRatio >= softLimit) {
    return {
      state: "warning",
      reason: "Soft budget limit reached",
      ratio: highestRatio,
      usage: next
    };
  }
  return { state: "ok", reason: "", ratio: highestRatio, usage: next };
}

export function remainingBudget(policy, usage) {
  const remaining = (policyKey, usageKey) => {
    const limit = configuredLimit(policy, policyKey);
    if (limit === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - finiteNonNegative(usage?.[usageKey] || 0, `Usage ${usageKey}`));
  };

  return {
    costUsd: remaining("maxCostUsd", "costUsd"),
    inputTokens: remaining("maxInputTokens", "inputTokens"),
    outputTokens: remaining("maxOutputTokens", "outputTokens"),
    toolCalls: remaining("maxToolCalls", "toolCalls"),
    iterations: remaining("maxIterations", "iterations"),
    runtimeMs: remaining("maxRuntimeMs", "runtimeMs")
  };
}
