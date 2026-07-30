import { describe, expect, it } from "vitest";
import { clampRenderedPosition } from "./graph-viewport";

describe("graph viewport bounds", () => {
  it("keeps a dragged item inside the visible canvas", () => {
    expect(clampRenderedPosition({ x: -120, y: 900 }, 800, 600)).toEqual({ x: 36, y: 564 });
  });

  it("preserves positions that are already visible", () => {
    expect(clampRenderedPosition({ x: 240, y: 180 }, 800, 600)).toEqual({ x: 240, y: 180 });
  });

  it("handles canvases smaller than twice the padding", () => {
    expect(clampRenderedPosition({ x: 100, y: -20 }, 40, 50)).toEqual({ x: 36, y: 36 });
  });
});
