#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    seconds: { type: "string", default: "60" },
    output: { type: "string" },
    headed: { type: "boolean", default: false },
    "drop-once": { type: "boolean", default: false },
  },
});
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds <= 0)
  throw new Error("--seconds must be positive");
const root = fileURLToPath(new URL("../", import.meta.url));
const output =
  values.output || (await mkdtemp(join(tmpdir(), "quasar-websocket-")));
await mkdir(output, { recursive: true });
const records = [];
const children = [];
let browser;
const summary = {
  opens: 0,
  closes: 0,
  frames: 0,
  protocolErrors: 0,
  uiErrors: 0,
  connected: false,
  phase: "connecting",
};
function redact(text) {
  return String(text).replace(
    /([?&](?:session|token|secret|password|api[_-]?key)=)[^\s&#"]+/gi,
    "$1[redacted]",
  );
}
function record(source, event, fields = {}) {
  const row = { timestamp: new Date().toISOString(), source, event, ...fields };
  records.push(JSON.parse(redact(JSON.stringify(row))));
  if (source !== "frame") console.log(redact(JSON.stringify(row)));
}
function launch(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (data) =>
    record(name, "stdout", { text: String(data) }),
  );
  child.stderr.on("data", (data) =>
    record(name, "stderr", { text: String(data) }),
  );
  child.on("error", (error) =>
    record(name, "error", { message: error.message }),
  );
  return child;
}
async function ready(url) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error("Stack process exited during startup");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Startup timed out: ${url}`);
}
try {
  let url = values.url;
  if (!url) {
    // Private data/config keep the inspector independent of the operator's running stack.
    const env = {
      ...process.env,
      XDG_DATA_HOME: join(output, "data"),
      XDG_CONFIG_HOME: join(output, "config"),
      QUASAR_INIT_FILE: "",
      QUASAR_STORAGE_PATH: join(output, "data/workspaces/"),
      QUASAR_LOG_LEVEL: "debug",
      QUASAR_HTTP_PORT: "8180",
      QUASAR_WS_PORT: "8181",
    };
    await mkdir(join(env.XDG_CONFIG_HOME, "quasar"), { recursive: true });
    await writeFile(
      join(env.XDG_CONFIG_HOME, "quasar/init.lisp"),
      '(setf quasar.plugin:*websocket-allowed-origins* (list "http://127.0.0.1:5183"))\n',
    );
    launch("server", "bash", ["scripts/run-control-plane"], { env });
    launch(
      "vite",
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "5183",
        "--strictPort",
      ],
      {
        cwd: join(root, "frontend"),
        env: {
          ...env,
          VITE_BASE_PATH: "/",
          VITE_CONTROL_PLANE_URL: "ws://127.0.0.1:8181",
        },
      },
    );
    await Promise.all([
      ready("http://127.0.0.1:8180/"),
      ready("http://127.0.0.1:5183/"),
    ]);
    url = "http://127.0.0.1:5183/";
  }
  browser = await chromium.launch({ headless: !values.headed });
  const page = await browser.newPage();
  if (values["drop-once"]) {
    let dropped = false;
    await page.routeWebSocket("**", (route) => {
      const server = route.connectToServer();
      route.onMessage((message) => {
        server.send(message);
        if (
          !dropped &&
          String(message).includes('"protocol":"quasar.control.v1"')
        ) {
          dropped = true;
          setTimeout(() => {
            record("inspector", "intentional-drop");
            route.close({ code: 4001, reason: "Inspector recovery test" });
            server.close();
          }, 2000);
        }
      });
    });
  }
  await page.exposeFunction("inspectUiError", (detail) => {
    summary.uiErrors++;
    record("ui", "error", { detail });
  });
  await page.addInitScript(() => {
    localStorage.setItem("quasar-debug", "1");
    window.addEventListener("quasar:control-plane-error", (event) =>
      window.inspectUiError(event.detail),
    );
    window.addEventListener("quasar:runtime-diagnostics", () => {
      const latest = JSON.parse(
        localStorage.getItem("quasar:runtime-diagnostics:v1") || "[]",
      )[0];
      console.debug("[inspector:diagnostic]", JSON.stringify(latest));
    });
  });
  page.on("console", (msg) => {
    const statePrefix = "[quasar-control:state] ";
    if (msg.text().startsWith(statePrefix)) {
      const state = JSON.parse(msg.text().slice(statePrefix.length));
      summary.connected = state.connected && state.synchronized;
      summary.phase = state.phase;
    }
    if (/quasar-control:|inspector:diagnostic/.test(msg.text()))
      record("browser", msg.type(), { text: msg.text() });
  });
  page.on("pageerror", (error) =>
    record("browser", "exception", { message: error.message }),
  );
  page.on("websocket", (ws) => {
    // Vite HMR is also a WebSocket; keep it distinct from quasar.control.v1.
    let control = false;
    let counted = false;
    record("socket", "created", { url: ws.url() });
    ws.on("framesent", (frame) => {
      try {
        control ||=
          JSON.parse(String(frame.payload)).protocol === "quasar.control.v1";
      } catch {}
      if (control && !counted) {
        counted = true;
        summary.opens++;
      }
    });
    ws.on("framereceived", (frame) => {
      if (!control) return;
      summary.frames++;
      try {
        const response = JSON.parse(String(frame.payload));
        if (response.status === "error") summary.protocolErrors++;
        record("frame", "received", {
          bytes: Buffer.byteLength(frame.payload),
          id: response.id,
          status: response.status,
          error: response.error,
          eventName: response.event,
          revision: response.result?.revision,
          page: response.result?.documentPage,
        });
      } catch {
        record("socket", "invalid-json", { url: ws.url() });
      }
    });
    ws.on("socketerror", (error) =>
      record("socket", "error", { url: ws.url(), error }),
    );
    ws.on("close", () => {
      if (control) summary.closes++;
      record("socket", "closed", { url: ws.url() });
    });
  });
  const target = new URL(url);
  target.searchParams.set("debug", "1");
  await page.goto(target.toString());
  console.log(`Inspecting for ${seconds}s; artifacts: ${output}`);
  const startupDelay = Math.min(1000, seconds * 1000);
  await page.waitForTimeout(startupDelay);
  await page.screenshot({ path: join(output, "startup.png") });
  record("ui", "startup-status", {
    label: await page.locator(".status-summary").innerText(),
  });
  await page.waitForTimeout(seconds * 1000 - startupDelay);
  summary.staleDisconnectNotice =
    summary.connected &&
    ((await page
      .getByText("The Common Lisp control plane disconnected.", { exact: true })
      .isVisible()) ||
      (await page
        .locator('[data-notice-code="control-plane.disconnected"]')
        .isVisible()));
  summary.statusLabel = await page.locator(".status-summary").innerText();
  await page.screenshot({ path: join(output, "ui.png") });
  record("inspector", "summary", summary);
  if (
    !summary.connected ||
    summary.staleDisconnectNotice ||
    (values["drop-once"] && (summary.closes !== 1 || summary.opens !== 2))
  ) {
    throw new Error(
      "Connection did not reach the expected synchronized/recovered state",
    );
  }
} catch (error) {
  record("inspector", "failed", { message: error.message });
  process.exitCode = 1;
} finally {
  // Capture summary before our own browser shutdown creates deliberate closes.
  await browser?.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          const timer = setTimeout(() => {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
  await writeFile(
    join(output, "events.jsonl"),
    records.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(`Inspection artifacts: ${output}`);
}
