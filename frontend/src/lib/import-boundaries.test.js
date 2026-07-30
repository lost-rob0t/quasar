import { describe, expect, it } from "vitest";
import { importSpecifiers, validateImport } from "../../scripts/check-boundaries.mjs";

describe("package import boundaries", () => {
  it("keeps core independent from UI, renderer, storage, and network runtimes", () => {
    for (const dependency of ["react", "cytoscape", "pouchdb-browser", "@stomp/stompjs"]) {
      expect(validateImport("src/core/example.ts", dependency)).toContain(
        "core must remain platform-independent"
      );
    }
  });

  it("allows Cytoscape only inside GraphAdapter", () => {
    expect(validateImport("src/components/GraphPage.jsx", "cytoscape")).toContain(
      "may only be imported"
    );
    expect(validateImport("src/graph/GraphAdapter.js", "cytoscape")).toBeNull();
    expect(validateImport("src/graph/GraphAdapter.js", "cytoscape-edgehandles")).toBeNull();
  });

  it("enforces dependency direction between package zones", () => {
    expect(validateImport("src/components/Panel.tsx", "../storage")).toContain(
      "components cannot depend on storage"
    );
    expect(validateImport("src/storage/repository.ts", "../components")).toContain(
      "storage cannot depend on components"
    );
    expect(validateImport("src/projections/counts.ts", "../core")).toBeNull();
    expect(validateImport("src/app/main.tsx", "../components")).toBeNull();
  });

  it("limits legacy bridges to package entrypoints", () => {
    expect(validateImport("src/graph/layout.ts", "../lib/graph.js")).toContain(
      "may only be bridged"
    );
    expect(validateImport("src/graph/index.ts", "../lib/graph.js")).toBeNull();
  });

  it("extracts static, re-exported, side-effect, and dynamic imports", () => {
    expect(
      importSpecifiers(`
        import "side-effect";
        import value from "package";
        export { item } from "../core";
        const lazy = import("../components");
      `)
    ).toEqual(["side-effect", "package", "../core", "../components"]);
  });
});
