const JS_LANGUAGES = new Set(["js", "javascript"]);
const JSON_LANGUAGES = new Set(["json"]);

function normalizeLanguage(language) {
  return String(language || "text").trim().toLowerCase();
}

function text(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function codeRuntime(language) {
  const normalized = normalizeLanguage(language);
  if (JS_LANGUAGES.has(normalized)) return "browser-worker";
  if (JSON_LANGUAGES.has(normalized)) return "json";
  return null;
}

export function codeBlockRunnable(language) {
  return codeRuntime(language) !== null;
}

function runJson(source) {
  return Promise.resolve({
    ok: true,
    runtime: "json",
    stdout: "",
    stderr: "",
    result: JSON.stringify(JSON.parse(source), null, 2)
  });
}

function workerSource() {
  return String.raw`
const deny = (name) => () => { throw new Error(name + " is disabled in Quasar code blocks"); };
self.fetch = deny("fetch");
self.XMLHttpRequest = class { constructor() { throw new Error("XMLHttpRequest is disabled in Quasar code blocks"); } };
self.WebSocket = class { constructor() { throw new Error("WebSocket is disabled in Quasar code blocks"); } };
self.EventSource = class { constructor() { throw new Error("EventSource is disabled in Quasar code blocks"); } };
self.importScripts = deny("importScripts");
try { self.caches = undefined; } catch {}
try { self.indexedDB = undefined; } catch {}

function render(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

self.onmessage = async (event) => {
  const source = String(event.data?.source || "");
  const stdout = [];
  const stderr = [];
  const console = {
    log: (...values) => stdout.push(values.map(render).join(" ")),
    info: (...values) => stdout.push(values.map(render).join(" ")),
    warn: (...values) => stderr.push(values.map(render).join(" ")),
    error: (...values) => stderr.push(values.map(render).join(" "))
  };

  try {
    if (/\bimport\s*\(/.test(source) || /\bimport\s+[^('"]/.test(source)) {
      throw new Error("Module imports are disabled in Quasar code blocks");
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      "console",
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "importScripts",
      "caches",
      "indexedDB",
      '"use strict";\n' + source
    );
    const result = await fn(
      console,
      deny("fetch"),
      self.XMLHttpRequest,
      self.WebSocket,
      self.EventSource,
      deny("importScripts"),
      undefined,
      undefined
    );
    self.postMessage({ ok: true, stdout: stdout.join("\n"), stderr: stderr.join("\n"), result: render(result) });
  } catch (error) {
    self.postMessage({
      ok: false,
      stdout: stdout.join("\n"),
      stderr: [stderr.join("\n"), error?.stack || error?.message || String(error)].filter(Boolean).join("\n"),
      result: ""
    });
  }
};
`;
}

function runJavaScript(source, timeoutMs) {
  return new Promise((resolve) => {
    const blob = new Blob([workerSource()], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { name: "quasar-code-block" });
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve({ runtime: "browser-worker", ...value });
    };

    const timer = setTimeout(
      () => finish({ ok: false, stdout: "", stderr: `Execution timed out after ${timeoutMs}ms`, result: "" }),
      timeoutMs
    );

    worker.onmessage = (event) => finish(event.data);
    worker.onerror = (event) =>
      finish({ ok: false, stdout: "", stderr: event.message || "Worker execution failed", result: "" });
    worker.postMessage({ source });
  });
}

export async function runCodeBlock({ language, source, timeoutMs = 2000 }) {
  const normalized = normalizeLanguage(language);
  const boundedTimeout = Math.max(100, Math.min(Number(timeoutMs) || 2000, 10000));

  if (JSON_LANGUAGES.has(normalized)) {
    try {
      return await runJson(source);
    } catch (error) {
      return { ok: false, runtime: "json", stdout: "", stderr: text(error?.message || error), result: "" };
    }
  }

  if (JS_LANGUAGES.has(normalized)) return runJavaScript(source, boundedTimeout);

  return {
    ok: false,
    runtime: null,
    stdout: "",
    stderr: `No sandboxed runtime is enabled for ${normalized || "text"} blocks.`,
    result: ""
  };
}
