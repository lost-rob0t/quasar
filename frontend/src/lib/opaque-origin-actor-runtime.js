import {
  actorContextApplicability,
  normalizeBrowserActorManifest,
  normalizeBrowserActorResult
} from "./browser-actor-runtime";

export const OPAQUE_ORIGIN_ACTOR_SANDBOX = "quasar.opaque-origin-iframe.v1";
export const OPAQUE_ORIGIN_SANDBOX_TOKENS = Object.freeze(["allow-scripts"]);

const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "worker-src blob:",
  "connect-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "style-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized === undefined ? "null" : serialized).byteLength;
}

function actorError(value, fallback = "Actor failed") {
  const error = new Error(value?.message || fallback);
  error.name = value?.name || "ActorError";
  error.stack = value?.stack || error.stack;
  return error;
}

function workerBootstrapSource() {
  return `
    "use strict";
    const nativePostMessage = globalThis.postMessage.bind(globalThis);
    const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
    const pending = new Map();
    let actor = null;
    let nextRequestId = 1;
    let requestCount = 0;
    let aborted = false;

    const send = (message) => nativePostMessage(message);
    const serializeError = (error) => ({
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || ""
    });
    const disable = (target, key) => {
      try {
        Object.defineProperty(target, key, {
          value: undefined,
          writable: false,
          configurable: false
        });
      } catch {}
    };
    const lockdown = () => {
      const denied = [
        "fetch",
        "XMLHttpRequest",
        "WebSocket",
        "EventSource",
        "importScripts",
        "Worker",
        "SharedWorker",
        "BroadcastChannel",
        "indexedDB",
        "caches",
        "postMessage",
        "close",
        "onmessage"
      ];
      let target = globalThis;
      while (target) {
        for (const key of denied) {
          if (Object.prototype.hasOwnProperty.call(target, key)) disable(target, key);
        }
        target = Object.getPrototypeOf(target);
      }
    };
    const postEvent = (event, data = {}) => send({ type: "event", event, data });
    const request = (capability, payload) => {
      if (aborted) return Promise.reject(new DOMException("Actor aborted", "AbortError"));
      if (!actor.capabilities.includes(capability)) {
        return Promise.reject(new Error("Actor capability denied: " + capability));
      }
      requestCount += 1;
      if (requestCount > actor.limits.maxRequests) {
        return Promise.reject(new RangeError("Actor exceeded capability request limit"));
      }
      const id = nextRequestId++;
      send({ type: "request", id, capability, payload });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };
    const buildApi = () => Object.freeze({
      actor: Object.freeze({ ...actor }),
      get aborted() { return aborted; },
      throwIfAborted() {
        if (aborted) throw new DOMException("Actor aborted", "AbortError");
      },
      progress(value, message = "") {
        postEvent("progress", { value: Number(value) || 0, message: String(message || "") });
      },
      log(level, message, data = null) {
        postEvent("log", {
          level: String(level || "info"),
          message: String(message || ""),
          data
        });
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

    nativeAddEventListener("message", async (event) => {
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
        for (const waiter of pending.values()) {
          waiter.reject(new DOMException("Actor aborted", "AbortError"));
        }
        pending.clear();
        return;
      }
      if (message.type !== "start" || actor) return;

      actor = Object.freeze(message.actor || {});
      let implementation;
      try {
        implementation = Function(
          '"use strict"; return (' + String(message.source || "") + ");"
        )();
      } catch (error) {
        send({ type: "error", error: serializeError(error) });
        return;
      }

      lockdown();
      try {
        postEvent("running", { actor });
        const actorThis = Object.freeze(Object.create(null));
        const result = await Reflect.apply(implementation, actorThis, [message.context, buildApi()]);
        if (aborted) throw new DOMException("Actor aborted", "AbortError");
        send({ type: "result", result: result || {} });
      } catch (error) {
        send({ type: "error", error: serializeError(error) });
      }
    });
  `;
}

export function buildOpaqueOriginActorFrameSource() {
  const workerSource = JSON.stringify(workerBootstrapSource()).replaceAll("<", "\\u003c");
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
      </head>
      <body>
        <script>
          "use strict";
          const WORKER_SOURCE = ${workerSource};
          let connected = false;
          addEventListener("message", (event) => {
            if (connected || event.data?.type !== "quasar-actor-connect" || !event.ports?.[0]) return;
            connected = true;
            const port = event.ports[0];
            const workerUrl = URL.createObjectURL(
              new Blob([WORKER_SOURCE], { type: "text/javascript" })
            );
            const worker = new Worker(workerUrl, { name: "quasar-opaque-origin-actor" });
            URL.revokeObjectURL(workerUrl);
            worker.onmessage = (workerEvent) => port.postMessage(workerEvent.data);
            worker.onmessageerror = () => port.postMessage({
              type: "crashed",
              error: { name: "DataCloneError", message: "Actor emitted an unreadable message" }
            });
            worker.onerror = (workerEvent) => port.postMessage({
              type: "crashed",
              error: { name: "ActorError", message: workerEvent.message || "Actor worker crashed" }
            });
            port.onmessage = (portEvent) => worker.postMessage(portEvent.data);
            port.onmessageerror = () => worker.terminate();
            port.start?.();
            port.postMessage({ type: "ready" });
          }, { once: true });
        <\/script>
      </body>
    </html>`;
}

function resolveEnvironment(options) {
  return {
    documentObject: options.documentObject || globalThis.document,
    MessageChannelClass: options.MessageChannelClass || globalThis.MessageChannel
  };
}

export function createOpaqueOriginBrowserActorRuntime(options = {}) {
  const services = { ...(options.services || {}) };
  const emitGlobal = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const environment = resolveEnvironment(options);
  const documentObject = environment.documentObject;

  if (!documentObject?.createElement || !environment.MessageChannelClass) {
    throw new Error("Opaque-origin actor runtime requires document and MessageChannel");
  }

  return Object.freeze({
    async run(manifest, context = {}, runOptions = {}) {
      const actor = normalizeBrowserActorManifest(manifest);
      const applicability = actorContextApplicability(actor, context);
      if (!applicability.applicable) throw new Error(applicability.reason);
      if (runOptions.signal?.aborted) throw new DOMException("Actor aborted", "AbortError");

      const timeoutMs = Math.min(
        Number(runOptions.timeoutMs) || actor.limits.timeoutMs,
        actor.limits.timeoutMs
      );
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new TypeError("Actor timeoutMs must be a positive integer");
      }

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

      const frame = documentObject.createElement("iframe");
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("sandbox", OPAQUE_ORIGIN_SANDBOX_TOKENS.join(" "));
      frame.referrerPolicy = "no-referrer";
      frame.srcdoc = buildOpaqueOriginActorFrameSource();

      const channel = new environment.MessageChannelClass();
      const port = channel.port1;
      const signal = runOptions.signal;
      let settled = false;
      let started = false;
      let requestCount = 0;
      let timer;

      const removeFrame = () => {
        if (typeof frame.remove === "function") frame.remove();
        else frame.parentNode?.removeChild?.(frame);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", handleAbort);
        try {
          port.close?.();
        } catch {}
        removeFrame();
      };
      const abort = () => {
        if (settled) return;
        try {
          port.postMessage({ type: "abort" });
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
            error: { name: error.name, message: error.message }
          });
        const respond = (message) => {
          if (settled) return;
          try {
            port.postMessage(message);
          } catch (error) {
            fail(error, "crashed");
          }
        };

        timer = setTimeout(() => {
          fail(new Error(`Actor timed out after ${timeoutMs}ms`), "timeout");
        }, timeoutMs);

        handleAbort = () => {
          abort();
          fail(new DOMException("Actor aborted", "AbortError"), "aborted");
        };
        signal?.addEventListener?.("abort", handleAbort, { once: true });

        port.onmessage = (event) => {
          const message = event.data || {};
          if (message.type === "ready") {
            if (started) return;
            started = true;
            emit("started", {
              runtime: actor.runtime,
              capabilities: actor.capabilities,
              sandbox: OPAQUE_ORIGIN_ACTOR_SANDBOX
            });
            respond({
              type: "start",
              actor,
              source: actor.source,
              context: cloneValue(context)
            });
            return;
          }
          if (message.type === "event") {
            emit(message.event || "event", message.data || {});
            return;
          }
          if (message.type === "request") {
            requestCount += 1;
            const capability = String(message.capability || "");
            emit("capability-request", { capability, requestCount });
            const deny = (error) =>
              respond({
                type: "response",
                id: message.id,
                ok: false,
                error: {
                  name: error.name,
                  message: error.message,
                  stack: error.stack || ""
                }
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
              service(cloneValue(message.payload), {
                actor,
                context: cloneValue(context),
                signal
              })
            )
              .then((value) => {
                if (byteLength(value) > actor.limits.maxResponseBytes) {
                  throw new RangeError(
                    `Capability response exceeds ${actor.limits.maxResponseBytes} bytes`
                  );
                }
                respond({ type: "response", id: message.id, ok: true, value });
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
                artifacts: result.artifacts.length,
                sandbox: OPAQUE_ORIGIN_ACTOR_SANDBOX
              });
            } catch (error) {
              fail(error);
            }
            return;
          }
          if (message.type === "error") fail(actorError(message.error));
          if (message.type === "crashed") {
            fail(actorError(message.error, "Actor sandbox crashed"), "crashed");
          }
        };
        port.onmessageerror = () =>
          fail(new Error("Actor sandbox emitted an unreadable message"), "crashed");
        frame.addEventListener("error", () => fail(new Error("Actor sandbox failed to load")));
        frame.addEventListener(
          "load",
          () => {
            try {
              frame.contentWindow.postMessage({ type: "quasar-actor-connect" }, "*", [
                channel.port2
              ]);
            } catch (error) {
              fail(error, "crashed");
            }
          },
          { once: true }
        );
        port.start?.();
        const host = documentObject.body || documentObject.documentElement;
        if (!host?.appendChild) {
          fail(new Error("Opaque-origin actor runtime requires a document root"));
          return;
        }
        host.appendChild(frame);
      });
    }
  });
}
