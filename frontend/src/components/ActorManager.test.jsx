import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ current: null }));
vi.mock("../store", () => ({ useQuasar: () => context.current }));

import ActorManager from "./ActorManager";

describe("ActorManager", () => {
  it("renders actor CRUD, code, config, and runtime controls", () => {
    context.current = {
      actors: [],
      persistSettings: vi.fn(),
      runActor: vi.fn(),
      selectedIds: [],
      settings: {
        actorsEnabled: false,
        actors: [
          {
            id: "quasar.actor.custom-test",
            label: "Custom test actor",
            description: "Editable actor",
            version: 1,
            accepts: ["*"],
            triggers: [],
            capabilities: [],
            limits: {},
            minSelection: 1,
            maxSelection: 1,
            source: "(context) => ({ documents: [], message: context.selection.length })"
          }
        ]
      },
      setNotice: vi.fn()
    };

    const html = renderToStaticMarkup(<ActorManager />);

    expect(html).toContain("Actor studio");
    expect(html).toContain("Create actor");
    expect(html).toContain("New actor");
    expect(html).toContain("Custom test actor");
    expect(html).toContain("built-in");
    expect(html).toContain("custom");
    expect(html).toContain("JavaScript actor function");
    expect(html).toContain("config");
    expect(html).toContain("runtime");
  });
});
