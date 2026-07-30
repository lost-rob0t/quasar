import { describe, expect, it } from "vitest";
import { normalizeBasePath, routerBasename } from "./base-path";

describe("application base path", () => {
  it.each([
    [undefined, "/"],
    ["", "/"],
    ["/", "/"],
    ["/quasar-ui", "/quasar-ui/"],
    ["/quasar-ui/", "/quasar-ui/"],
    [" /teams/investigations/ ", "/teams/investigations/"]
  ])("normalizes %j to %s", (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it.each([
    "quasar-ui",
    "//example.com/quasar-ui/",
    "https://example.com/quasar-ui/",
    "/quasar-ui?preview=1",
    String.raw`\quasar-ui`
  ])("rejects invalid base path %j", (input) => {
    expect(() => normalizeBasePath(input)).toThrow("VITE_BASE_PATH must be an absolute URL path");
  });

  it("omits the React Router basename for root hosting", () => {
    expect(routerBasename("/")).toBeUndefined();
  });

  it("removes the trailing slash from a subpath basename", () => {
    expect(routerBasename("/quasar-ui/")).toBe("/quasar-ui");
  });
});
