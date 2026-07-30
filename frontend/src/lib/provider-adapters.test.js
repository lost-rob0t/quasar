import { describe, expect, it, vi } from "vitest";
import { ProviderError, createProviderAdapter, normalizeProviderError } from "./provider-adapters";

describe("provider adapters", () => {
  it("uses one OpenAI-compatible request contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "response-1",
          choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        }),
        { status: 200 }
      )
    );
    const adapter = createProviderAdapter({
      id: "local",
      name: "Local",
      type: "local",
      baseUrl: "http://localhost:11434/v1",
      requiresKey: false
    });
    const result = await adapter.sendMessages({
      model: "test",
      messages: [{ role: "user", content: "run" }]
    });
    expect(result.text).toBe("ok");
    expect(result.usage.inputTokens).toBe(10);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/v1/chat/completions",
      expect.any(Object)
    );
    fetchMock.mockRestore();
  });

  it("normalizes rate limits without response bodies or secrets", () => {
    const response = new Response("", { status: 429, headers: { "retry-after": "2" } });
    const error = normalizeProviderError(null, response);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("rate_limit");
    expect(error.retryAfterMs).toBe(2_000);
  });
});
