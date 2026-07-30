import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginUserNavigation,
  endUserNavigation,
  installUserNavigationGuard,
  isGraphUserNavigationActive,
  isUserNavigationActive,
  markUserNavigation
} from "./user-navigation-guard";

afterEach(() => vi.restoreAllMocks());

describe("user navigation guard", () => {
  it("tracks the active navigation window", () => {
    const state = { until: 0 };
    markUserNavigation(state, 100, 360);

    expect(isUserNavigationActive(state, 459)).toBe(true);
    expect(isUserNavigationActive(state, 460)).toBe(false);
  });

  it("stays active for the complete pointer gesture and release cooldown", () => {
    const state = { until: 0, pointers: new Set() };
    beginUserNavigation(state, 7);

    expect(isUserNavigationActive(state, 10_000)).toBe(true);

    endUserNavigation(state, 7, 10_000, 360);
    expect(isUserNavigationActive(state, 10_359)).toBe(true);
    expect(isUserNavigationActive(state, 10_360)).toBe(false);
  });

  it("tracks graph navigation without intercepting native pan steps", () => {
    const nativePanBy = vi.fn();
    const containerListeners = new Map();
    const windowListeners = new Map();
    let navigationHandler = null;
    const rootWindow = {
      addEventListener: vi.fn((type, handler) => windowListeners.set(type, handler)),
      removeEventListener: vi.fn()
    };
    const container = {
      ownerDocument: { defaultView: rootWindow },
      addEventListener: vi.fn((type, handler) => containerListeners.set(type, handler)),
      removeEventListener: vi.fn()
    };
    const cy = {
      container: () => container,
      panBy: nativePanBy,
      on: vi.fn((events, handler) => {
        if (events.includes("dragpan")) navigationHandler = handler;
      }),
      off: vi.fn()
    };
    const restore = installUserNavigationGuard(cy, 360);

    vi.spyOn(Date, "now").mockReturnValue(100);
    containerListeners.get("pointerdown")({ pointerId: 12 });
    navigationHandler();

    Date.now.mockReturnValue(1_000);
    cy.panBy({ x: 10, y: 5 });
    expect(nativePanBy).toHaveBeenCalledWith({ x: 10, y: 5 });
    expect(isGraphUserNavigationActive(cy)).toBe(true);

    windowListeners.get("pointerup")({ pointerId: 12 });
    Date.now.mockReturnValue(1_359);
    expect(isGraphUserNavigationActive(cy)).toBe(true);

    Date.now.mockReturnValue(1_360);
    expect(isGraphUserNavigationActive(cy)).toBe(false);

    restore();
    expect(cy.off).toHaveBeenCalled();
    expect(container.removeEventListener).toHaveBeenCalled();
    expect(rootWindow.removeEventListener).toHaveBeenCalled();
    expect(isGraphUserNavigationActive(cy)).toBe(false);
  });
});
