import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ current: null }));
vi.mock("../store", () => ({ useQuasar: () => context.current }));
vi.mock("../lib/starintel-server", () => ({ listStarIntelActors: vi.fn().mockResolvedValue([]) }));

import ActorManager from "./ActorManager";

describe("ActorManager", () => {
  it("renders while settings are still loading", () => {
    context.current = {
      actors: [],
      persistSettings: vi.fn(),
      runActor: vi.fn(),
      selectedIds: [],
      settings: null,
      setNotice: vi.fn()
    };

    expect(renderToStaticMarkup(<ActorManager />)).toContain("Actor studio");
  });

  it("lists built-in actors with read-only manifests and no authoring controls", () => {
    context.current = {
      actors: [],
      persistSettings: vi.fn(),
      runActor: vi.fn(),
      selectedIds: [],
      settings: {},
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(<ActorManager />);

    expect(html).toContain("Actor studio");
    expect(html).toContain("built-in");
    expect(html).toContain("config");
    expect(html).toContain("runtime");
    // Browser-actor authoring is gone: no create/new/code-editor surface.
    expect(html).not.toContain("Create actor");
    expect(html).not.toContain("New actor");
    expect(html).not.toContain("JavaScript actor function");
    expect(html).not.toContain("Enable custom actor execution");
  });
});
