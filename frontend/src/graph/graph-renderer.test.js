import { describe, expect, it } from "vitest";
import {
  GRAPH_RENDERER_AUTO,
  GRAPH_RENDERER_CANVAS,
  GRAPH_RENDERER_WEBGL,
  graphRendererPreferenceFromEnv,
  normalizeGraphRendererPreference,
  resolveGraphRenderer
} from "./graph-renderer";

describe("normalizeGraphRendererPreference", () => {
  it("accepts the supported renderer modes", () => {
    expect(normalizeGraphRendererPreference("auto")).toBe(GRAPH_RENDERER_AUTO);
    expect(normalizeGraphRendererPreference("CANVAS")).toBe(GRAPH_RENDERER_CANVAS);
    expect(normalizeGraphRendererPreference(" webgl ")).toBe(GRAPH_RENDERER_WEBGL);
  });

  it("falls back to auto for invalid input", () => {
    expect(normalizeGraphRendererPreference("wat")).toBe(GRAPH_RENDERER_AUTO);
    expect(normalizeGraphRendererPreference()).toBe(GRAPH_RENDERER_AUTO);
  });
});

describe("graphRendererPreferenceFromEnv", () => {
  it("keeps Canvas as the unconfigured production default", () => {
    expect(graphRendererPreferenceFromEnv({})).toBe(GRAPH_RENDERER_CANVAS);
  });

  it("allows auto and WebGL to be enabled explicitly", () => {
    expect(graphRendererPreferenceFromEnv({ VITE_GRAPH_RENDERER: "auto" })).toBe(
      GRAPH_RENDERER_AUTO
    );
    expect(graphRendererPreferenceFromEnv({ VITE_GRAPH_RENDERER: "webgl" })).toBe(
      GRAPH_RENDERER_WEBGL
    );
  });
});

describe("resolveGraphRenderer", () => {
  it("prefers WebGL in auto mode when the browser supports it", () => {
    expect(resolveGraphRenderer({ preference: "auto", webglSupported: true })).toEqual({
      requested: GRAPH_RENDERER_AUTO,
      backend: GRAPH_RENDERER_WEBGL,
      webgl: true,
      fallback: false
    });
  });

  it("keeps Canvas when explicitly requested", () => {
    expect(resolveGraphRenderer({ preference: "canvas", webglSupported: true })).toEqual({
      requested: GRAPH_RENDERER_CANVAS,
      backend: GRAPH_RENDERER_CANVAS,
      webgl: false,
      fallback: false
    });
  });

  it("falls back safely when WebGL is requested but unavailable", () => {
    expect(resolveGraphRenderer({ preference: "webgl", webglSupported: false })).toEqual({
      requested: GRAPH_RENDERER_WEBGL,
      backend: GRAPH_RENDERER_CANVAS,
      webgl: false,
      fallback: true
    });
  });
});
