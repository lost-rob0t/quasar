export const BROWSER_ACTOR_RUNTIME = "quasar.browser-js.v1";

export const BROWSER_ACTOR_CAPABILITIES = Object.freeze([
  "documents.get",
  "documents.query",
  "network.fetch",
  "browser.open",
  "events.emit",
  "artifacts.write"
]);

const CAPABILITY_SET = new Set(BROWSER_ACTOR_CAPABILITIES);
const MAX_SELECTION = 256;
const HARD_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxDocuments: 4_096,
  maxOperations: 8_192,
  maxArtifacts: 512,
  maxRequests: 2_048,
  maxResponseBytes: 8 * 1_024 * 1_024,
  maxResultBytes: 32 * 1_024 * 1_024
});

export const DEFAULT_BROWSER_ACTOR_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxDocuments: 1_024,
  maxOperations: 2_048,
  maxArtifacts: 128,
  maxRequests: 256,
  maxResponseBytes: 1 * 1_024 * 1_024,
  maxResultBytes: 8 * 1_024 * 1_024
});

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeStringList(value, fallback = []) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new TypeError("Actor manifest list fields must be arrays");
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized;
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Actor limits must be an object");
  }
  return Object.fromEntries(
    Object.entries(DEFAULT_BROWSER_ACTOR_LIMITS).map(([key, fallback]) => [
      key,
      boundedInteger(value[key], fallback, 1, HARD_LIMITS[key], `Actor ${key}`)
    ])
  );
}

export function normalizeBrowserActorManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Actor manifest must be an object");
  }

  const minSelection = boundedInteger(
    manifest.minSelection,
    1,
    0,
    MAX_SELECTION,
    "Actor minSelection"
  );
  const maxSelection = boundedInteger(
    manifest.maxSelection,
    32,
    minSelection,
    MAX_SELECTION,
    "Actor maxSelection"
  );
  const capabilities = normalizeStringList(manifest.capabilities);
  const unknownCapability = capabilities.find((capability) => !CAPABILITY_SET.has(capability));
  if (unknownCapability) throw new TypeError(`Unsupported actor capability: ${unknownCapability}`);

  const actor = {
    id: String(manifest.id || "").trim(),
    label: String(manifest.label || manifest.id || "").trim(),
    description: String(manifest.description || "").trim(),
    version: Number(manifest.version || 1),
    runtime: String(manifest.runtime || BROWSER_ACTOR_RUNTIME).trim(),
    accepts: normalizeStringList(manifest.accepts, ["*"]),
    triggers: normalizeStringList(manifest.triggers),
    capabilities,
    minSelection,
    maxSelection,
    limits: normalizeLimits(manifest.limits),
    source: String(manifest.source || "").trim()
  };

  if (!actor.id) throw new TypeError("Actor id is required");
  if (!actor.label) throw new TypeError("Actor label is required");
  if (!Number.isInteger(actor.version) || actor.version < 1) {
    throw new TypeError("Actor version must be a positive integer");
  }
  if (actor.runtime !== BROWSER_ACTOR_RUNTIME) {
    throw new TypeError(`Unsupported actor runtime: ${actor.runtime || "<missing>"}`);
  }
  if (!actor.accepts.length)
    throw new TypeError("Actor accepts must contain at least one object type");
  if (!actor.source) throw new TypeError("Actor source is required");

  return actor;
}

export function browserActorManifestFromLegacy(manifest) {
  return normalizeBrowserActorManifest({
    ...manifest,
    runtime: BROWSER_ACTOR_RUNTIME,
    capabilities: manifest?.capabilities || [],
    limits: {
      ...manifest?.limits,
      ...(manifest?.timeoutMs === undefined ? {} : { timeoutMs: manifest.timeoutMs })
    }
  });
}

export function actorContextApplicability(manifest, context = {}) {
  const actor = normalizeBrowserActorManifest(manifest);
  const selection = Array.isArray(context.selection) ? context.selection : [];
  if (selection.length < actor.minSelection) {
    return {
      applicable: false,
      reason:
        actor.minSelection === 1
          ? "Select a graph document."
          : `Select at least ${actor.minSelection} graph documents.`
    };
  }
  if (selection.length > actor.maxSelection) {
    return {
      applicable: false,
      reason: `Select no more than ${actor.maxSelection} graph documents.`
    };
  }
  const accepted = new Set(actor.accepts);
  if (!accepted.has("*")) {
    const rejected = selection.find((document) => !accepted.has(document?.dtype));
    if (rejected)
      return { applicable: false, reason: `Does not accept ${rejected.dtype} documents.` };
  }
  return { applicable: true, reason: "" };
}

export function normalizeBrowserActorResult(result, manifest) {
  const actor = normalizeBrowserActorManifest(manifest);
  const value = result === undefined || result === null ? {} : result;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Actor result must be an object");
  }

  const documents = value.documents === undefined ? [] : value.documents;
  const operations = value.operations === undefined ? [] : value.operations;
  const artifacts = value.artifacts === undefined ? [] : value.artifacts;
  if (!Array.isArray(documents)) throw new TypeError("Actor result documents must be an array");
  if (!Array.isArray(operations)) throw new TypeError("Actor result operations must be an array");
  if (!Array.isArray(artifacts)) throw new TypeError("Actor result artifacts must be an array");
  if (documents.length > actor.limits.maxDocuments) {
    throw new RangeError(`Actor returned more than ${actor.limits.maxDocuments} documents`);
  }
  if (operations.length > actor.limits.maxOperations) {
    throw new RangeError(`Actor returned more than ${actor.limits.maxOperations} operations`);
  }
  if (artifacts.length > actor.limits.maxArtifacts) {
    throw new RangeError(`Actor returned more than ${actor.limits.maxArtifacts} artifacts`);
  }

  const normalized = {
    documents: cloneValue(documents),
    operations: cloneValue(operations),
    artifacts: cloneValue(artifacts),
    message: String(value.message || "").trim(),
    metrics:
      value.metrics && typeof value.metrics === "object" && !Array.isArray(value.metrics)
        ? cloneValue(value.metrics)
        : {}
  };
  if (byteLength(normalized) > actor.limits.maxResultBytes) {
    throw new RangeError(`Actor result exceeds ${actor.limits.maxResultBytes} bytes`);
  }
  return normalized;
}

export function buildBrowserActorWorkerSource(manifest) {
  const actor = normalizeBrowserActorManifest(manifest);
  const actorMeta = JSON.stringify({
    id: actor.id,
    label: actor.label,
    version: actor.version,
    capabilities: actor.capabilities,
    limits: actor.limits
  });

  return `
    "use strict";
    const ACTOR = ${actorMeta};
    const ALLOWED = new Set(ACTOR.capabilities);
    const pending = new Map();
    let nextRequestId = 1;
    let requestCount = 0;
    let aborted = false;

    for (const key of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"]) {
      try { Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false }); } catch {}
    }

    const postEvent = (event, data = {}) => self.postMessage({ type: "event", event, data });
    const serializeError = (error) => ({
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || ""
    });
    const request = (capability, payload) => {
      if (aborted) return Promise.reject(new DOMException("Actor aborted", "AbortError"));
      if (!ALLOWED.has(capability)) return Promise.reject(new Error("Actor capability denied: " + capability));
      requestCount += 1;
      if (requestCount > ACTOR.limits.maxRequests) {
        return Promise.reject(new RangeError("Actor exceeded capability request limit"));
      }
      const id = nextRequestId++;
      self.postMessage({ type: "request", id, capability, payload });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };
    const api = Object.freeze({
      actor: ACTOR,
      get aborted() { return aborted; },
      throwIfAborted() {
        if (aborted) throw new DOMException("Actor aborted", "AbortError");
      },
      progress(value, message = "") {
        postEvent("progress", { value: Number(value) || 0, message: String(message || "") });
      },
      log(level, message, data = null) {
        postEvent("log", { level: String(level || "info"), message: String(message || ""), data });
      },
      request,
      documents: Object.freeze({
        get: (id) => request("documents.get", { id }),
        query: (query) => request("documents.query", query)
      }),
      network: Object.freeze({ fetch: (input) => request("network.fetch", input) }),
      browser: Object.freeze({ open: (url) => request("browser.open", { url }) }),
      events: Object.freeze({ emit: (event) => request("events.emit", event) }),
      artifacts: Object.freeze({ write: (artifact) => request("artifacts.write", artifact) })
    });
    const implementation = (${actor.source});

    self.onmessage = async (event) => {
      const message = event.data || {};
      if (message.type === "response") {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.value);
        else {
          const error = new Error(message.error?.message || "Capability request failed");
          error.name = message.error?.name || "ActorCapabilityError";
          error.stack = message.error?.stack || error.stack;
          waiter.reject(error);
        }
        return;
      }
      if (message.type === "abort") {
        aborted = true;
        for (const waiter of pending.values()) waiter.reject(new DOMException("Actor aborted", "AbortError"));
        pending.clear();
        return;
      }
      if (message.type !== "start") return;

      try {
        postEvent("running", { actor: ACTOR });
        const result = await implementation(message.context, api);
        api.throwIfAborted();
        self.postMessage({ type: "result", result: result || {} });
      } catch (error) {
        self.postMessage({ type: "error", error: serializeError(error) });
      }
    };
  `;
}

function actorError(value, fallback = "Actor failed") {
  const error = new Error(value?.message || fallback);
  error.name = value?.name || "ActorError";
  error.stack = value?.stack || error.stack;
  return error;
}

function resolveEnvironment(options) {
  return {
    WorkerClass: options.WorkerClass || globalThis.Worker,
    BlobClass: options.BlobClass || globalThis.Blob,
    URLObject: options.URLObject || globalThis.URL
  };
}

export function createBrowserActorRuntime(options = {}) {
  const services = { ...(options.services || {}) };
  const emitGlobal = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const environment = resolveEnvironment(options);

  if (
    !environment.WorkerClass ||
    !environment.BlobClass ||
    !environment.URLObject?.createObjectURL
  ) {
    throw new Error("Browser actor runtime requires Worker, Blob, and URL.createObjectURL");
  }

  return Object.freeze({
    async run(manifest, context = {}, runOptions = {}) {
      const actor = normalizeBrowserActorManifest(manifest);
      const applicability = actorContextApplicability(actor, context);
      if (!applicability.applicable) throw new Error(applicability.reason);

      const timeoutMs = boundedInteger(
        runOptions.timeoutMs,
        actor.limits.timeoutMs,
        1,
        actor.limits.timeoutMs,
        "Actor timeoutMs"
      );
      const emitRun = typeof runOptions.onEvent === "function" ? runOptions.onEvent : () => {};
      const emit = (event, data = {}) => {
        const payload = { actorId: actor.id, event, at: new Date().toISOString(), data };
        try {
          emitGlobal(payload);
        } catch {}
        try {
          emitRun(payload);
        } catch {}
      };

      if (runOptions.signal?.aborted) throw new DOMException("Actor aborted", "AbortError");

      const source = buildBrowserActorWorkerSource(actor);
      const url = environment.URLObject.createObjectURL(
        new environment.BlobClass([source], { type: "text/javascript" })
      );
      const worker = new environment.WorkerClass(url, { name: actor.id });
      const signal = runOptions.signal;
      let settled = false;
      let requestCount = 0;
      let timer;

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", handleAbort);
        worker.terminate();
        environment.URLObject.revokeObjectURL(url);
      };
      const abort = () => {
        if (settled) return;
        try {
          worker.postMessage({ type: "abort" });
        } catch {}
      };
      let handleAbort = abort;

      return new Promise((resolve, reject) => {
        const finish = (fn, value, event, data = {}) => {
          if (settled) return;
          settled = true;
          cleanup();
          emit(event, data);
          fn(value);
        };

        const fail = (error, event = "failed") =>
          finish(reject, error, event, {
            error: {
              name: error.name,
              message: error.message
            }
          });

        timer = setTimeout(() => {
          fail(new Error(`Actor timed out after ${timeoutMs}ms`), "timeout");
        }, timeoutMs);

        handleAbort = () => {
          abort();
          fail(new DOMException("Actor aborted", "AbortError"), "aborted");
        };
        signal?.addEventListener?.("abort", handleAbort, { once: true });

        worker.onmessage = (event) => {
          const message = event.data || {};
          if (message.type === "event") {
            emit(message.event || "event", message.data || {});
            return;
          }
          if (message.type === "request") {
            requestCount += 1;
            const capability = String(message.capability || "");
            emit("capability-request", { capability, requestCount });
            const deny = (error) =>
              worker.postMessage({
                type: "response",
                id: message.id,
                ok: false,
                error: { name: error.name, message: error.message, stack: error.stack || "" }
              });
            if (!actor.capabilities.includes(capability)) {
              deny(new Error(`Actor capability denied: ${capability}`));
              return;
            }
            if (requestCount > actor.limits.maxRequests) {
              deny(new RangeError("Actor exceeded capability request limit"));
              return;
            }
            const service = services[capability];
            if (typeof service !== "function") {
              deny(new Error(`Actor capability unavailable: ${capability}`));
              return;
            }
            Promise.resolve(
              service(cloneValue(message.payload), { actor, context: cloneValue(context), signal })
            )
              .then((value) => {
                if (byteLength(value) > actor.limits.maxResponseBytes) {
                  throw new RangeError(
                    `Capability response exceeds ${actor.limits.maxResponseBytes} bytes`
                  );
                }
                worker.postMessage({ type: "response", id: message.id, ok: true, value });
              })
              .catch(deny);
            return;
          }
          if (message.type === "result") {
            try {
              const result = normalizeBrowserActorResult(message.result, actor);
              finish(resolve, result, "completed", {
                documents: result.documents.length,
                operations: result.operations.length,
                artifacts: result.artifacts.length
              });
            } catch (error) {
              fail(error);
            }
            return;
          }
          if (message.type === "error") fail(actorError(message.error));
        };

        worker.onerror = (event) =>
          fail(new Error(event.message || "Actor worker crashed"), "crashed");
        emit("started", { runtime: actor.runtime, capabilities: actor.capabilities });
        worker.postMessage({ type: "start", context: cloneValue(context) });
      });
    }
  });
}
