(() => {
  const pending = new Map();
  const subscribers = new Map();
  let sequence = 0;

  function nextId() {
    sequence += 1;
    return `ui-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function hostWindow() {
    return window.parent === window ? window : window.parent;
  }

  function bridgeElement() {
    const bridge = hostWindow().document.getElementById("quasar-command-bridge");
    if (!bridge) throw new Error("Quasar CLOG command bridge is unavailable");
    return bridge;
  }

  function send(command, payload = {}) {
    const id = nextId();
    const envelope = JSON.stringify({
      v: 1,
      kind: "command",
      id,
      command,
      payload
    });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const bridge = bridgeElement();
      bridge.dataset.envelope = envelope;
      bridge.click();
    });
  }

  function deliver(encoded) {
    const envelope = typeof encoded === "string" ? JSON.parse(encoded) : encoded;
    if (envelope.kind === "event") {
      const handlers = subscribers.get(envelope.event) || new Set();
      handlers.forEach((handler) => handler(envelope.payload));
      return;
    }
    const waiter = pending.get(envelope.id);
    if (!waiter) return;
    pending.delete(envelope.id);
    if (envelope.ok) waiter.resolve(envelope.value);
    else {
      const error = new Error(envelope.error?.message || "Control-plane command failed");
      error.code = envelope.error?.code;
      error.details = envelope.error?.details;
      waiter.reject(error);
    }
  }

  function subscribe(eventName, handler) {
    const handlers = subscribers.get(eventName) || new Set();
    handlers.add(handler);
    subscribers.set(eventName, handlers);
    return () => handlers.delete(handler);
  }

  const api = Object.freeze({
    send,
    deliver,
    subscribe,
    capabilities: () => send("system.capabilities"),
    snapshot: () => send("workspace.snapshot"),
    apply: (operation) => send("workspace.apply", { operation }),
    starlangStatus: () => send("starlang.status"),
    loadStarLang: (source) => send("starlang.load", { source })
  });

  hostWindow().QuasarControlPlaneHost = api;
  window.QuasarControlPlane = api;

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "quasar-control-plane-command") return;
    send(event.data.command, event.data.payload)
      .then((value) => event.source?.postMessage({
        type: "quasar-control-plane-result",
        id: event.data.id,
        ok: true,
        value
      }, event.origin))
      .catch((error) => event.source?.postMessage({
        type: "quasar-control-plane-result",
        id: event.data.id,
        ok: false,
        error: { code: error.code, message: error.message, details: error.details }
      }, event.origin));
  });
})();
