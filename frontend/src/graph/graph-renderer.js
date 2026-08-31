export const GRAPH_RENDERER_AUTO = "auto";
export const GRAPH_RENDERER_CANVAS = "canvas";
export const GRAPH_RENDERER_WEBGL = "webgl";

const VALID_RENDERERS = new Set([
  GRAPH_RENDERER_AUTO,
  GRAPH_RENDERER_CANVAS,
  GRAPH_RENDERER_WEBGL
]);

export function normalizeGraphRendererPreference(preference) {
  const normalized = String(preference || GRAPH_RENDERER_AUTO).trim().toLowerCase();
  return VALID_RENDERERS.has(normalized) ? normalized : GRAPH_RENDERER_AUTO;
}

export function detectWebGLSupport(documentRef = globalThis.document) {
  if (!documentRef?.createElement) return false;

  try {
    const canvas = documentRef.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function resolveGraphRenderer({
  preference = GRAPH_RENDERER_AUTO,
  webglSupported = detectWebGLSupport()
} = {}) {
  const requested = normalizeGraphRendererPreference(preference);
  const wantsWebGL = requested === GRAPH_RENDERER_WEBGL || requested === GRAPH_RENDERER_AUTO;
  const webgl = wantsWebGL && webglSupported;

  return {
    requested,
    backend: webgl ? GRAPH_RENDERER_WEBGL : GRAPH_RENDERER_CANVAS,
    webgl,
    fallback: requested === GRAPH_RENDERER_WEBGL && !webglSupported
  };
}

export function graphRendererPreferenceFromEnv(env = import.meta.env) {
  return normalizeGraphRendererPreference(env?.VITE_GRAPH_RENDERER);
}
