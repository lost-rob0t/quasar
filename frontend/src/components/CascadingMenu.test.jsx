import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Play, Trash2 } from "lucide-react";

import CascadingMenu from "./CascadingMenu";

describe("CascadingMenu", () => {
  it("renders the root panel with leaves and cascade affordances", () => {
    const items = [
      { label: "Edit", Icon: Play, onSelect: vi.fn() },
      {
        label: "Run actor",
        Icon: Play,
        children: [{ label: "Built-in", onSelect: vi.fn() }]
      },
      { label: "Delete", Icon: Trash2, danger: true, onSelect: vi.fn() }
    ];
    const html = renderToStaticMarkup(
      <div style={{ position: "relative" }}>
        <CascadingMenu x={10} y={10} items={items} header="doc-1" onClose={vi.fn()} />
      </div>
    );
    expect(html).toContain("Edit");
    expect(html).toContain("Run actor");
    expect(html).toContain("Delete");
    // Cascading paths advertise the submenu; leaves do not.
    expect(html).toContain("aria-haspopup");
    expect(html).toContain("cascading-item");
  });
});
