const PROVIDER_TYPES = new Set(["openrouter", "openai", "anthropic", "openai-compatible", "local"]);
const PROTECTED_PROVIDER_ENDPOINTS = Object.freeze({
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  local: "http://localhost:11434/v1"
});
const FORBIDDEN_CONFIG_HEADER =
  /^(?:authorization|proxy-|host$|cookie$|set-cookie$|origin$|referer$|sec-|x-api-key$)/i;

export class ProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderError";
    Object.assign(this, details);
  }
}

function requiredString(value, label) {
  const result = String(value || "").trim();
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}

function normalizeBaseUrl(value) {
  const url = new URL(requiredString(value, "Provider base URL"));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("Provider URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("Provider URL cannot contain embedded credentials");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "::1" || /^127\./.test(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new TypeError("Provider URL must use HTTPS unless it targets loopback");
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/, "");
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const normalized = String(name || "").trim();
      if (!normalized || FORBIDDEN_CONFIG_HEADER.test(normalized)) {
        throw new TypeError(`Provider header is not allowed: ${normalized || "<empty>"}`);
      }
      return [normalized, String(value)];
    })
  );
}

function parseRetryAfter(headers) {
  const value = headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function normalizeProviderError(error, response) {
  if (error?.name === "AbortError") {
    return new ProviderError("Provider request cancelled", { code: "cancelled", retryable: false });
  }
  if (response) {
    const status = response.status;
    return new ProviderError(
      status === 401 || status === 403
        ? "Provider rejected the key"
        : status === 429
          ? "Provider rate limit reached"
          : status >= 500
            ? "Provider is unavailable"
            : `Provider request failed (${status})`,
      {
        code:
          status === 429 ? "rate_limit" : status >= 500 ? "provider_unavailable" : "request_failed",
        status,
        retryable: status === 408 || status === 409 || status === 429 || status >= 500,
        retryAfterMs: parseRetryAfter(response.headers)
      }
    );
  }
  return new ProviderError(error?.message || "Provider request failed", {
    code: "network_error",
    retryable: true
  });
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw normalizeProviderError(null, response);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError("Provider returned invalid JSON", {
      code: "invalid_response",
      retryable: true
    });
  }
}

function usageFromOpenAi(data) {
  const usage = data?.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    cachedTokens: Number(
      usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens || 0
    ),
    exact: Boolean(data?.usage)
  };
}

function openAiAdapter(config, secret) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...(config.headers || {}),
    ...(secret ? { Authorization: `Bearer ${secret}` } : {})
  };
  return {
    type: config.type,
    async listModels({ signal } = {}) {
      try {
        const data = await readJson(await fetch(`${baseUrl}/models`, { headers, signal }));
        return (data.data || data.models || []).map((model) => ({
          id: model.id || model.name,
          name: model.name || model.id,
          contextWindow: model.context_length || model.context_window || null
        }));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw normalizeProviderError(error);
      }
    },
    async sendMessages({
      model,
      messages,
      tools = [],
      toolChoice = "auto",
      maxTokens,
      temperature,
      signal
    }) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            model,
            messages,
            ...(tools.length ? { tools, tool_choice: toolChoice } : {}),
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {})
          })
        });
        const data = await readJson(response);
        const message = data.choices?.[0]?.message;
        if (!message)
          throw new ProviderError("Provider response has no message", {
            code: "invalid_response",
            retryable: true
          });
        return {
          id: data.id || crypto.randomUUID(),
          text: message.content || "",
          toolCalls: (message.tool_calls || []).map((call) => ({
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments || "{}"
          })),
          finishReason: data.choices?.[0]?.finish_reason || null,
          usage: usageFromOpenAi(data),
          providerMessage: message,
          raw: data
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw normalizeProviderError(error);
      }
    },
    streamMessages(request) {
      return this.sendMessages(request);
    },
    cancel(controller) {
      controller?.abort();
    }
  };
}

function anthropicAdapter(config, secret) {
  const baseUrl = normalizeBaseUrl(config.baseUrl || "https://api.anthropic.com/v1");
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": secret,
    "anthropic-version": config.apiVersion || "2023-06-01"
  };
  return {
    type: "anthropic",
    async listModels({ signal } = {}) {
      try {
        const data = await readJson(await fetch(`${baseUrl}/models`, { headers, signal }));
        return (data.data || []).map((model) => ({
          id: model.id,
          name: model.display_name || model.id,
          contextWindow: null
        }));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw normalizeProviderError(error);
      }
    },
    async sendMessages({ model, messages, tools = [], maxTokens = 4_096, temperature, signal }) {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const turns = messages
        .filter((message) => message.role !== "system")
        .map((message) =>
          message.role === "tool"
            ? {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: message.tool_call_id,
                    content: message.content
                  }
                ]
              }
            : message
        );
      try {
        const data = await readJson(
          await fetch(`${baseUrl}/messages`, {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify({
              model,
              system,
              messages: turns,
              max_tokens: maxTokens,
              ...(tools.length
                ? {
                    tools: tools.map((tool) => ({
                      name: tool.function.name,
                      description: tool.function.description,
                      input_schema: tool.function.parameters
                    }))
                  }
                : {}),
              ...(temperature !== undefined ? { temperature } : {})
            })
          })
        );
        return {
          id: data.id || crypto.randomUUID(),
          text: (data.content || [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          toolCalls: (data.content || [])
            .filter((part) => part.type === "tool_use")
            .map((part) => ({
              id: part.id,
              name: part.name,
              arguments: JSON.stringify(part.input || {})
            })),
          finishReason: data.stop_reason || null,
          usage: {
            inputTokens: Number(data.usage?.input_tokens || 0),
            outputTokens: Number(data.usage?.output_tokens || 0),
            cachedTokens: Number(data.usage?.cache_read_input_tokens || 0),
            exact: Boolean(data.usage)
          },
          providerMessage: { role: "assistant", content: data.content || [] },
          raw: data
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw normalizeProviderError(error);
      }
    },
    streamMessages(request) {
      return this.sendMessages(request);
    },
    cancel(controller) {
      controller?.abort();
    }
  };
}

export const DEFAULT_PROVIDER_CONFIGS = Object.freeze([
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true
  },
  {
    id: "anthropic",
    name: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true
  },
  {
    id: "custom",
    name: "OpenAI-compatible",
    type: "openai-compatible",
    baseUrl: "",
    requiresKey: false
  },
  {
    id: "local",
    name: "Local model",
    type: "local",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false
  }
]);

export function normalizeProviderConfig(input) {
  const type = requiredString(input.type, "Provider type");
  if (!PROVIDER_TYPES.has(type)) throw new TypeError(`Unsupported provider type: ${type}`);
  const id = requiredString(input.id, "Provider ID");
  const rawBaseUrl = String(input.baseUrl || "").trim();
  const baseUrl = rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : "";
  const protectedEndpoint = PROTECTED_PROVIDER_ENDPOINTS[id];
  if (protectedEndpoint && baseUrl !== protectedEndpoint) {
    throw new TypeError(`${id} must use its built-in reviewed endpoint`);
  }
  return {
    id,
    name: requiredString(input.name || input.id, "Provider name"),
    type,
    baseUrl,
    requiresKey: input.requiresKey !== false && type !== "local",
    enabled: input.enabled !== false,
    headers: sanitizeHeaders(input.headers)
  };
}

export function createProviderAdapter(input, secret = "") {
  const config = normalizeProviderConfig(input);
  if (config.requiresKey && !secret)
    throw new ProviderError("Provider key is missing", { code: "missing_key", retryable: false });
  if (config.type === "anthropic") return anthropicAdapter(config, secret);
  return openAiAdapter(config, secret);
}

export async function testProviderConnection(config, secret, { signal } = {}) {
  const adapter = createProviderAdapter(config, secret);
  const models = await adapter.listModels({ signal });
  return { connected: true, modelCount: models.length, models: models.slice(0, 100) };
}
