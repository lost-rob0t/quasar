import { describe, expect, it, vi } from "vitest";
import {
  boxesOverlap,
  relationDropPadding,
  selectionBoxFromPoints,
  selectNodesInRenderedBox,
  selectSingleNode
} from "./graph-gestures";

describe("graph gestures", () => {
  it("detects a relation drop when node boxes overlap", () => {
    expect(
      boxesOverlap({ x1: 10, y1: 10, x2: 30, y2: 30 }, { x1: 28, y1: 18, x2: 48, y2: 38 })
    ).toBe(true);
  });

  it("allows a small drop target margin", () => {
    expect(
      boxesOverlap({ x1: 10, y1: 10, x2: 30, y2: 30 }, { x1: 38, y1: 10, x2: 58, y2: 30 }, 8)
    ).toBe(true);
  });

  it("rejects separated node boxes", () => {
    expect(
      boxesOverlap({ x1: 10, y1: 10, x2: 30, y2: 30 }, { x1: 60, y1: 60, x2: 80, y2: 80 }, 8)
    ).toBe(false);
  });

  it("uses a larger relation target for touch dragging", () => {
    expect(relationDropPadding("touch")).toBeGreaterThan(relationDropPadding("mouse"));
    expect(relationDropPadding("pen")).toBe(relationDropPadding("touch"));
  });

  it("normalizes a right-drag rectangle in every direction", () => {
    expect(selectionBoxFromPoints({ x: 80, y: 70 }, { x: 20, y: 10 })).toEqual({
      x1: 20,
      y1: 10,
      x2: 80,
      y2: 70
    });
  });

  it("left or right click selection replaces every other selected node", () => {
    const unselect = vi.fn();
    const select = vi.fn();
    const node = {
      length: 1,
      selected: vi.fn(() => false),
      select
    };
    const selected = {
      not: vi.fn(() => ({ length: 2, unselect }))
    };
    const cy = {
      $: vi.fn(() => selected),
      batch: vi.fn((callback) => callback())
    };

    expect(selectSingleNode(cy, node)).toBe(true);
    expect(cy.$).toHaveBeenCalledWith("node:selected");
    expect(selected.not).toHaveBeenCalledWith(node);
    expect(unselect).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
  });

  it("right-drag selects nodes overlapping the rendered box", () => {
    const makeNode = (id, bounds, initiallySelected = false) => {
      let selected = initiallySelected;
      return {
        id: () => id,
        visible: () => true,
        renderedBoundingBox: () => bounds,
        selected: () => selected,
        select: vi.fn(() => {
          selected = true;
        }),
        unselect: vi.fn(() => {
          selected = false;
        })
      };
    };

    const outside = makeNode("outside", { x1: 120, y1: 120, x2: 140, y2: 140 }, true);
    const first = makeNode("first", { x1: 10, y1: 10, x2: 30, y2: 30 });
    const second = makeNode("second", { x1: 45, y1: 45, x2: 70, y2: 70 });
    const nodes = [outside, first, second];
    const cy = {
      nodes: () => nodes,
      $: vi.fn(() => ({
        get length() {
          return nodes.filter((node) => node.selected()).length;
        },
        unselect: () => nodes.filter((node) => node.selected()).forEach((node) => node.unselect())
      })),
      batch: vi.fn((callback) => callback())
    };

    const selectedIds = selectNodesInRenderedBox(cy, {
      x1: 0,
      y1: 0,
      x2: 60,
      y2: 60
    });

    expect(selectedIds).toEqual(["first", "second"]);
    expect(outside.unselect).toHaveBeenCalledOnce();
    expect(first.select).toHaveBeenCalledOnce();
    expect(second.select).toHaveBeenCalledOnce();
  });
});
