import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("browser actor configuration boundary", () => {
  it("does not restore browser-owned actor configuration", () => {
    expect(() => readFileSync(`${ROOT}/lib/actor-configuration.js`, "utf8")).toThrow();
    expect(read("./opaque-origin-actor-host.js")).not.toContain("loadActorConfiguration");
    expect(read("./actor-transforms.js")).not.toContain("context.configuration");
    expect(read("./actor-transforms.js")).not.toContain("configuredContext");
    expect(read("../components/RunAllTransformationsBridge.jsx")).not.toContain(
      "actorConfigurationStatus"
    );
  });
});
