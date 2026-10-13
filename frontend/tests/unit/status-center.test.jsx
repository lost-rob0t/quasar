import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { quasarHealth } from "../../src/ui-core/adapters/shared";
import StatusCenter from "../../src/ui-core/StatusCenter";

const state = vi.hoisted(() => ({ health: [] }));
vi.mock("../../src/store", () => ({ useQuasar: () => state }));
vi.mock("../../src/ui-core/runtime", () => ({
  useUiRuntime: () => ({ label: "Common Lisp Quasar", health: (value) => value.health })
}));

function render(control, extras = {}) {
  state.health = quasarHealth(
    { controlPlaneStatus: control, ...extras },
    { requireControlPlane: true }
  );
  return renderToStaticMarkup(<StatusCenter />);
}

describe("control plane status presentation", () => {
  it("shows a healthy workspace when optional connections are stopped", () => {
    const html = render({ phase: "connected", connected: true, synchronized: true });
    expect(html).toContain("status-success");
    expect(html).toContain("Common Lisp Quasar");
    expect(html).not.toContain("Degraded");
  });

  it("shows synchronization separately from disconnected transport", () => {
    const html = render({
      phase: "synchronizing",
      connected: false,
      progress: { received: 400, total: 1000 }
    });
    expect(html).toContain("Loading workspace");
    expect(html).toContain("status-warning");
    expect(state.health[0].detail).toContain("WebSocket connected");
    expect(state.health[0].detail).toContain("400 / 1,000 documents");
  });

  it("shows reconnecting during retry and errors for real failures", () => {
    expect(render({ phase: "reconnecting", connected: false })).toContain("Reconnecting");
    expect(render({ phase: "disconnected", connected: false })).toContain("status-danger");
    expect(
      render({ connected: true }, { serverStatus: { state: "error", message: "Request failed" } })
    ).toContain("Degraded");
  });
});
