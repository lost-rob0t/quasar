function normalizeState(value, fallback = "offline") {
  return String(value || fallback).toLowerCase();
}

function item(id, label, status, detail, critical = false) {
  return {
    id,
    label,
    status: normalizeState(status),
    detail: String(detail || ""),
    critical
  };
}

export function quasarHealth(state, { requireControlPlane = false } = {}) {
  const rows = [];
  if (requireControlPlane) {
    const control = state.controlPlaneStatus || {};
    rows.push(
      item(
        "control-plane",
        "Quasar control plane",
        control.connected
          ? "online"
          : ["connecting", "reconnecting"].includes(control.phase)
            ? control.phase
            : "error",
        control.connected
          ? "Connected and authoritative"
          : `${control.phase || "disconnected"}${control.attempts ? ` · reconnect attempt ${control.attempts}` : ""}`,
        true
      )
    );
  }

  rows.push(
    item("couchdb", "CouchDB sync", state.syncStatus?.state, state.syncStatus?.message),
    item("server", "StarIntel Server", state.serverStatus?.state, state.serverStatus?.message),
    item("queue", "RabbitMQ", state.queueStatus?.state, state.queueStatus?.message)
  );

  return rows;
}

export function standaloneHealth(state) {
  return [
    item("workspace", "Browser workspace", "online", "Local standalone authority", true),
    ...quasarHealth(state)
  ];
}

export function autoDigHealth(state) {
  return [
    item("host", "Auto-Dig host", "online", "Embedded host bridge active", true),
    ...quasarHealth(state, { requireControlPlane: true })
  ];
}
