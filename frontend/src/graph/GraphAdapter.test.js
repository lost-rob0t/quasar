import { describe, expect, it } from "vitest";
import {
  adaptiveWheelSensitivity,
  automaticNodePosition,
  createGraphAdapter,
  DEFAULT_WHEEL_SENSITIVITY,
  MAX_WHEEL_SENSITIVITY,
  TARGET_RENDERED_NODE_SIZE
} from "./GraphAdapter";

const extent = { x1: -500, y1: -300, x2: 500, y2: 300 };

describe("adaptiveWheelSensitivity", () => {
  it("keeps normal-sized nodes at the controlled base sensitivity", () => {
    expect(adaptiveWheelSensitivity(TARGET_RENDERED_NODE_SIZE, -100)).toBe(
      DEFAULT_WHEEL_SENSITIVITY
    );
    expect(adaptiveWheelSensitivity(TARGET_RENDERED_NODE_SIZE, 100)).toBe(
      DEFAULT_WHEEL_SENSITIVITY
    );
  });

  it("accelerates zoom-in when fitted nodes are tiny", () => {
    expect(adaptiveWheelSensitivity(3, -100)).toBeGreaterThan(2);
    expect(adaptiveWheelSensitivity(1, -100)).toBe(MAX_WHEEL_SENSITIVITY);
  });

  it("does not accelerate away from tiny nodes", () => {
    expect(adaptiveWheelSensitivity(3, 100)).toBe(DEFAULT_WHEEL_SENSITIVITY);
  });

  it("accelerates zoom-out when nodes are oversized", () => {
    expect(adaptiveWheelSensitivity(TARGET_RENDERED_NODE_SIZE * 4, 100)).toBeGreaterThan(1);
    expect(adaptiveWheelSensitivity(TARGET_RENDERED_NODE_SIZE * 4, -100)).toBe(
      DEFAULT_WHEEL_SENSITIVITY
    );
  });

  it("falls back to the base sensitivity for invalid input", () => {
    expect(adaptiveWheelSensitivity(0, -100)).toBe(DEFAULT_WHEEL_SENSITIVITY);
    expect(adaptiveWheelSensitivity(Number.NaN, -100)).toBe(DEFAULT_WHEEL_SENSITIVITY);
    expect(adaptiveWheelSensitivity(4, 0)).toBe(DEFAULT_WHEEL_SENSITIVITY);
  });
});

describe("automaticNodePosition", () => {
  it("spreads a batch of new nodes instead of stacking them", () => {
    const positions = Array.from({ length: 24 }, (_, index) =>
      automaticNodePosition(index, extent)
    );
    const unique = new Set(positions.map(({ x, y }) => `${x.toFixed(4)}:${y.toFixed(4)}`));

    expect(unique.size).toBe(positions.length);
  });

  it("keeps generated positions finite around the visible graph extent", () => {
    const positions = Array.from({ length: 24 }, (_, index) =>
      automaticNodePosition(index, extent)
    );

    for (const position of positions) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(Math.abs(position.x)).toBeLessThan(1000);
      expect(Math.abs(position.y)).toBeLessThan(1000);
    }
  });

  it("uses native left drag and native single-click selection", () => {
    const cy = createGraphAdapter({
      headless: true,
      styleEnabled: false,
      elements: [],
      selectionType: "additive"
    });

    expect(cy.userPanningEnabled()).toBe(true);
    expect(cy.boxSelectionEnabled()).toBe(false);
    expect(cy.selectionType()).toBe("single");
    cy.destroy();
  });
});
