import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ current: null }));
vi.mock("../store", () => ({ useQuasar: () => context.current }));
import ProActorManager from "./ProActorManager";

describe("Pro actor panel", () => {
  it.each(["off", "auto", "on"])("renders %s safely without known entitlement", (mode) => {
    context.current = {
      documents: [],
      selectedDocuments: [],
      settings: { proIntegrationMode: mode },
      controlPlaneStatus: { connected: false }
    };
    const html = renderToStaticMarkup(<ProActorManager />);
    if (mode === "on") {
      expect(html).toContain("Pro actors");
      expect(html).toContain("Connect the Quasar control plane");
      expect(html).not.toContain("Run ");
    } else expect(html).toBe("");
  });
});
