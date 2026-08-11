import { describe, expect, it, vi } from "vitest";
import { openImportedGraph } from "./graph-navigation";

describe("import-to-graph navigation", () => {
  it("selects imported IDs and opens a graph session that reveals unreviewed records", () => {
    const select = vi.fn();
    const navigate = vi.fn();
    const opened = openImportedGraph({
      importedIds: ["starintel:org:a", "starintel:relation:a-b", "starintel:org:a"],
      select,
      navigate
    });

    const ids = ["starintel:org:a", "starintel:relation:a-b"];
    expect(opened).toBe(true);
    expect(select).toHaveBeenCalledWith(ids);
    expect(navigate).toHaveBeenCalledWith("/graph", {
      state: {
        importedIds: ids,
        revealUnreviewed: true,
        source: "local-import"
      }
    });
  });

  it("does not navigate when the import committed no documents", () => {
    const navigate = vi.fn();
    expect(openImportedGraph({ importedIds: [], select: vi.fn(), navigate })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
