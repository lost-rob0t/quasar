let sequence = 0;
const pending = new Map();

function nextId() {
  sequence += 1;
  return `ui-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function send(command, payload = {}) {
  if (window.parent === window) {
    if (!window.QuasarControlPlane) {
      return Promise.reject(new Error("Quasar control plane host is unavailable"));
    }
    return window.QuasarControlPlane.send(command, payload);
  }

  const id = nextId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage({
      type: "quasar-control-plane-command",
      id,
      command,
      payload
    }, "*");
  });
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "quasar-control-plane-result") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.value);
  else {
    const error = new Error(message.error?.message || "Control-plane command failed");
    error.code = message.error?.code;
    error.details = message.error?.details;
    waiter.reject(error);
  }
});

export const controlPlane = Object.freeze({
  send,
  capabilities: () => send("system.capabilities"),
  snapshot: () => send("workspace.snapshot"),
  apply: (operation) => send("workspace.apply", { operation }),
  starlangStatus: () => send("starlang.status"),
  loadStarLang: (source) => send("starlang.load", { source })
});
