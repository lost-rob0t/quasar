import { describe, expect, it } from "vitest";
import { budgetState, calculateCost, remainingBudget } from "./agent-budget";

describe("agent budget fail-closed behavior", () => {
  it("treats an explicit zero limit as a hard stop", () => {
    expect(budgetState({ maxCostUsd: 0 }, {}, {}).state).toBe("hard-stop");
  });

  it("rejects unknown and implicit zero pricing", () => {
    expect(() => calculateCost({ inputTokens: 10 }, { known: false })).toThrow(/pricing/i);
    expect(() =>
      calculateCost(
        { outputTokens: 10 },
        {
          inputPerMillionUsd: 0,
          outputPerMillionUsd: 0,
          cachedInputPerMillionUsd: 0
        }
      )
    ).toThrow(/free/i);
  });

  it("allows explicitly free models", () => {
    expect(calculateCost({ inputTokens: 10, outputTokens: 20 }, { free: true })).toBe(0);
  });

  it("represents absent limits as unbounded", () => {
    expect(remainingBudget({}, {}).costUsd).toBe(Number.POSITIVE_INFINITY);
  });
});
