import { useEffect, useMemo, useState } from "react";
import {
  Database,
  Download,
  File,
  Files,
  Network,
  Palette,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  Server,
  Square,
  Trash2,
  Upload,
  UploadCloud
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { normalizeActorManifest } from "../lib/actors";
import { openImportedGraph } from "../lib/graph-navigation";
import { createSettingsExport, parseSettingsImport } from "../lib/settings-transfer";
import { applyTheme, THEMES } from "../lib/themes";
import { useQuasar } from "../store";

export function Report({ report }) {
  if (!report) return null;
  return (
    <section className="panel import-report">
      <h2>Import report</h2>
      <div className="metadata-grid">
        <div className="key-value">
          <span>Files</span>
          <strong>{report.fileCount}</strong>
        </div>
        <div className="key-value">
          <span>Candidates</span>
          <strong>{report.candidateCount}</strong>
        </div>
        <div className="key-value">
          <span>Saved</span>
          <strong>{report.saved?.length || 0}</strong>
        </div>
        <div className="key-value">
          <span>Skipped</span>
          <strong>{report.skipped?.length || 0}</strong>
        </div>
        <div className="key-value">
          <span>Invalid/write errors</span>
          <strong>{report.errors?.length || 0}</strong>
        </div>
        <div className="key-value">
          <span>Parse errors</span>
          <strong>{report.parseErrors?.length || 0}</strong>
        </div>
        <div className="key-value">
          <span>Manifest mode</span>
          <strong>
            {report.manifestMode === "bundle" ? "Resolve references" : "Documents only"}
          </strong>
        </div>
        <div className="key-value">
          <span>Rolled back</span>
          <strong>{report.rolledBack || 0}</strong>
        </div>
        <div className="key-value">
          <span>Schema revision</span>
          <strong>{report.validator?.schemaRevision || "unknown"}</strong>
        </div>
        <div className="key-value">
          <span>Validator profile</span>
          <strong>
            {report.validator
              ? `${report.validator.profile} ${report.validator.profileVersion}`
              : "unknown"}
          </strong>
        </div>
      </div>
      {[...(report.parseErrors || []), ...(report.errors || [])].map((error, index) => (
        <div className="validation-error" key={`${error.file || error.id || "error"}:${index}`}>
          <strong>
            {error.file || error.id || `Record ${error.record || Number(error.index || 0) + 1}`}
          </strong>
          <span>
            {error.line ? `line ${error.line}: ` : ""}
            {error.id && error.file ? `${error.id}: ` : ""}
            {error.phase ? `${error.phase}: ` : ""}
            {error.message}
          </span>
          {error.validation?.map((item, position) => (
            <code key={position}>
              {item.path || "/"}
              {item.keyword ? ` [${item.keyword}]` : ""} {item.message}
            </code>
          ))}
        </div>
      ))}
    </section>
  );
}

export function ImportPage() {
  const navigate = useNavigate();
  const { importFileSet, select, setNotice } = useQuasar();
  const [files, setFiles] = useState([]);
  const [replace, setReplace] = useState(false);
  const [resolveManifestReferences, setResolveManifestReferences] = useState(false);
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);

  async function runImport(nextFiles = files, { openGraph = false } = {}) {
    if (!nextFiles.length) return;
    setRunning(true);
    try {
      const next = await importFileSet(nextFiles, { replace, resolveManifestReferences });
      setReport(next);
      setNotice({
        kind: next.errors?.length || next.parseErrors?.length ? "warning" : "success",
        message: `Imported ${next.saved?.length || 0} document(s)`
      });
      if (openGraph && !openImportedGraph({ importedIds: next.importedIds, select, navigate })) {
        setNotice({ kind: "warning", message: "No newly saved documents are available to open" });
      }
    } catch (error) {
      setReport(error.report || null);
      setNotice({ kind: "error", message: error.message });
    } finally {
      setRunning(false);
    }
  }

  const chooseSingle = (event) => {
    const next = Array.from(event.target.files || []).slice(0, 1);
    setFiles(next);
    setReport(null);
  };
  const chooseBulk = (event) => {
    const next = Array.from(event.target.files || []);
    setFiles(next);
    setReport(null);
  };

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Ingest</span>
          <h1>Import documents</h1>
          <p>Import one file, a bulk selection, or a manifest plus its referenced files.</p>
        </div>
      </div>

      <div className="import-grid">
        <label className="upload-card">
          <File size={28} />
          <strong>Single file</strong>
          <span>JSON, JSONL, NDJSON, or CSV</span>
          <input
            type="file"
            accept=".json,.jsonl,.ndjson,.csv,application/json"
            onChange={chooseSingle}
          />
        </label>
        <label className="upload-card">
          <Files size={28} />
          <strong>Bulk files</strong>
          <span>Import StarIntel documents directly or enable bundle manifest checks below</span>
          <input
            type="file"
            multiple
            accept=".json,.jsonl,.ndjson,.csv,application/json"
            onChange={chooseBulk}
          />
        </label>
      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>Import queue</h2>
          <span>{files.length} files</span>
        </div>
        <div className="file-list">
          {files.map((file) => (
            <div key={`${file.name}:${file.size}`}>
              <File size={15} />
              <span>{file.name}</span>
              <small>{Math.ceil(file.size / 1024)} KB</small>
            </div>
          ))}
          {!files.length && <p className="muted">No files selected.</p>}
        </div>
        <div className="form-actions import-actions">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />{" "}
            Replace matching IDs even when the incoming version is not newer
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={resolveManifestReferences}
              onChange={(event) => setResolveManifestReferences(event.target.checked)}
            />{" "}
            Treat manifests as bundle instructions and require every referenced file
          </label>
          <div className="button-row">
            <button
              className="button"
              disabled={!files.length || running}
              onClick={() => runImport()}
            >
              <UploadCloud size={16} /> {running ? "Validating and saving…" : "Save locally"}
            </button>
            <button
              className="button primary"
              disabled={!files.length || running}
              onClick={() => runImport(files, { openGraph: true })}
            >
              <Network size={16} /> Save and open graph
            </button>
          </div>
        </div>
      </section>
      <Report report={report} />
    </section>
  );
}

const ACTOR_TEMPLATE = JSON.stringify(
  {
    id: "quasar.actor.example",
    label: "Example actor",
    description: "Describe what this actor returns.",
    version: 1,
    accepts: ["*"],
    minSelection: 1,
    maxSelection: 8,
    source: `(context) => ({ documents: [], message: "Selected " + context.selection.length + " document(s)" })`
  },
  null,
  2
);

export function SettingsPage() {
  const {
    settings,
    persistSettings,
    syncStatus,
    startSync,
    stopSync,
    synchronize,
    serverStatus,
    queueStatus,
    testServer,
    startQueue,
    stopQueue,
    databaseInfo,
    ensureStarIntelViews,
    setNotice
  } = useQuasar();
  const [form, setForm] = useState(settings || {});
  const [actorText, setActorText] = useState(ACTOR_TEMPLATE);
  const [info, setInfo] = useState(null);
  const [viewStatus, setViewStatus] = useState("");
  const actors = useMemo(() => form.actors || [], [form.actors]);

  useEffect(() => setForm(settings || {}), [settings]);
  useEffect(() => {
    databaseInfo()
      .then(setInfo)
      .catch(() => {});
  }, [databaseInfo]);
  const update = (key) => (event) =>
    setForm((current) => ({
      ...current,
      [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value
    }));
  const changeTheme = (event) => {
    const theme = applyTheme(event.target.value);
    setForm((current) => ({ ...current, theme }));
  };

  async function save() {
    try {
      await persistSettings(form);
      setNotice({ kind: "success", message: "Settings saved locally" });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function sync(direction) {
    try {
      await persistSettings(form);
      await synchronize(direction, form);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function beginLiveSync() {
    try {
      await persistSettings(form);
      startSync(form);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function probeServer() {
    try {
      await persistSettings(form);
      const result = await testServer(form);
      setNotice({
        kind: "success",
        message:
          result.mode === "v1"
            ? "Connected to StarIntel API v1"
            : "Connected using the legacy gserver API"
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function beginQueue() {
    try {
      const next = { ...form, rabbitEnabled: true };
      setForm(next);
      await persistSettings(next);
      startQueue(next);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function endQueue() {
    const next = { ...form, rabbitEnabled: false };
    setForm(next);
    stopQueue();
    await persistSettings(next);
  }

  async function installViews() {
    try {
      const result = await ensureStarIntelViews();
      const changed = result.filter((item) => item.status !== "current").length;
      setViewStatus(`${result.length} design documents ready · ${changed} changed`);
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function exportSettingsFile() {
    const contents = JSON.stringify(createSettingsExport(form), null, 2);
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "quasar-settings.json";
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ kind: "success", message: "Settings exported without passwords or tokens" });
  }

  async function importSettingsFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = parseSettingsImport(await file.text());
      const next = { ...form, ...imported };
      next.theme = applyTheme(next.theme);
      setForm(next);
      await persistSettings(next);
      setNotice({ kind: "success", message: "Settings imported" });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function addActor() {
    try {
      const actor = normalizeActorManifest(JSON.parse(actorText));
      const nextActors = [...actors.filter((item) => item.id !== actor.id), actor];
      setForm((current) => ({ ...current, actors: nextActors }));
      setNotice({
        kind: "success",
        message: `Actor staged: ${actor.id}. Save settings to persist it.`
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function removeActor(id) {
    setForm((current) => ({
      ...current,
      actors: (current.actors || []).filter((actor) => actor.id !== id)
    }));
  }

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Configuration</span>
          <h1>Settings</h1>
          <p>
            Local storage, StarIntel services, optional queue ingest, synchronization, and browser
            actors.
          </p>
        </div>
        <button className="button primary" onClick={save}>
          <Save size={16} /> Save settings
        </button>
      </div>

      <section className="panel">
        <div className="section-heading">
          <h2>Appearance</h2>
          <Palette size={20} />
        </div>
        <div className="theme-settings">
          <label className="field">
            <span>Theme</span>
            <select value={form.theme || "midnight"} onChange={changeTheme}>
              {THEMES.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>
          <div className="theme-swatches" aria-hidden="true">
            {THEMES.find((theme) => theme.id === (form.theme || "midnight"))?.tokens
              ? ["bg", "panel", "accent", "accent2", "warm", "success"].map((token) => (
                  <span
                    key={token}
                    style={{
                      background: THEMES.find((theme) => theme.id === (form.theme || "midnight"))
                        .tokens[token]
                    }}
                  />
                ))
              : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Import / export settings</h2>
        </div>
        <p className="muted">Passwords and tokens are never exported.</p>
        <div className="button-row">
          <button className="button" type="button" onClick={exportSettingsFile}>
            <Download size={15} /> Export settings
          </button>
          <label className="button settings-file-button">
            <Upload size={15} /> Import settings
            <input type="file" accept=".json,application/json" onChange={importSettingsFile} />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>StarIntel server</h2>
          <span className={`sync-badge sync-${serverStatus.state}`}>{serverStatus.state}</span>
        </div>
        <p className="muted">
          Quasar probes the expanded v1 capability endpoint first and falls back to the current
          gserver routes for target submission.
        </p>
        <div className="form-grid">
          <label className="field full">
            <span>Server URL</span>
            <input
              value={form.serverUrl || ""}
              onChange={update("serverUrl")}
              placeholder="http://localhost:5000"
            />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              value={form.serverUsername || ""}
              onChange={update("serverUsername")}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={form.serverPassword || ""}
              onChange={update("serverPassword")}
              autoComplete="current-password"
            />
          </label>
          <label className="field full">
            <span>Bearer token</span>
            <input
              type="password"
              value={form.serverToken || ""}
              onChange={update("serverToken")}
              placeholder="Optional; takes precedence over basic auth"
            />
          </label>
        </div>
        <p className="muted sync-message">{serverStatus.message}</p>
        <button className="button primary" onClick={probeServer} disabled={!form.serverUrl}>
          <Server size={15} /> Test server connection
        </button>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>RabbitMQ graph ingest</h2>
          <span className={`sync-badge sync-${queueStatus.state}`}>{queueStatus.state}</span>
        </div>
        <p className="muted">
          Uses RabbitMQ Web STOMP, validates each delivery with the canonical v0.9 schema, saves it
          to local PouchDB, and adds accepted IDs to the active graph.
        </p>
        <div className="form-grid">
          <label className="field full">
            <span>Web STOMP URL</span>
            <input
              value={form.rabbitWebSocketUrl || ""}
              onChange={update("rabbitWebSocketUrl")}
              placeholder="ws://localhost:15674/ws"
            />
          </label>
          <label className="field full">
            <span>Destination</span>
            <input
              value={form.rabbitDestination || ""}
              onChange={update("rabbitDestination")}
              placeholder="/exchange/documents/documents.update.#"
            />
          </label>
          <label className="field">
            <span>Queue name</span>
            <input
              value={form.rabbitQueueName || ""}
              onChange={update("rabbitQueueName")}
              placeholder="Optional durable queue"
            />
          </label>
          <label className="field">
            <span>Virtual host</span>
            <input value={form.rabbitVhost || "/"} onChange={update("rabbitVhost")} />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              value={form.rabbitUsername || ""}
              onChange={update("rabbitUsername")}
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={form.rabbitPassword || ""}
              onChange={update("rabbitPassword")}
              autoComplete="current-password"
            />
          </label>
          <label className="field">
            <span>Prefetch</span>
            <input
              type="number"
              min="1"
              max="500"
              value={form.rabbitPrefetch || 25}
              onChange={update("rabbitPrefetch")}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.rabbitEnabled)}
              onChange={update("rabbitEnabled")}
            />{" "}
            Start listener when Quasar opens
          </label>
        </div>
        <p className="muted sync-message">
          {queueStatus.message} · {queueStatus.accepted} accepted · {queueStatus.rejected} rejected
          {queueStatus.lastError ? ` · ${queueStatus.lastError}` : ""}
        </p>
        <div className="button-row">
          <button
            className="button primary"
            onClick={beginQueue}
            disabled={!form.rabbitWebSocketUrl || !form.rabbitDestination}
          >
            <RadioTower size={15} /> Start listener
          </button>
          <button className="button danger" onClick={endQueue}>
            <Square size={14} /> Stop listener
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>CouchDB synchronization</h2>
          <span className={`sync-badge sync-${syncStatus.state}`}>{syncStatus.state}</span>
        </div>
        <div className="form-grid">
          <label className="field full">
            <span>CouchDB server URL</span>
            <input
              value={form.couchUrl || ""}
              onChange={update("couchUrl")}
              placeholder="https://couch.example.org"
            />
          </label>
          <label className="field">
            <span>Database</span>
            <input value={form.couchDatabase || "starintel"} onChange={update("couchDatabase")} />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={form.couchUsername || ""} onChange={update("couchUsername")} />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={form.couchPassword || ""}
              onChange={update("couchPassword")}
            />
          </label>
        </div>
        <p className="muted sync-message">{syncStatus.message}</p>
        <div className="button-row">
          <button className="button" onClick={() => sync("pull")} disabled={!form.couchUrl}>
            Pull once
          </button>
          <button className="button" onClick={() => sync("push")} disabled={!form.couchUrl}>
            Push once
          </button>
          <button className="button" onClick={() => sync("both")} disabled={!form.couchUrl}>
            Sync once
          </button>
          <button className="button primary" onClick={beginLiveSync} disabled={!form.couchUrl}>
            <Play size={15} /> Start live sync
          </button>
          <button className="button danger" onClick={stopSync}>
            Stop
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Browser actors</h2>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.actorsEnabled)}
              onChange={update("actorsEnabled")}
            />{" "}
            Enable actor execution
          </label>
        </div>
        <p className="muted">
          Bundled actors run without enabling custom code. Custom actors run as Web Workers and
          return StarIntel document batches. Returned documents pass through canonical validation
          and transaction-level undo.
        </p>
        <div className="actor-list">
          {actors.map((actor) => (
            <div key={actor.id} className="actor-row">
              <div>
                <strong>{actor.label}</strong>
                <code>
                  {actor.id} · v{actor.version}
                </code>
              </div>
              <button className="icon-button danger" onClick={() => removeActor(actor.id)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {!actors.length && (
            <p className="muted">
              No custom actors configured. The built-in deterministic actor remains available when
              actors are enabled.
            </p>
          )}
        </div>
        <label className="field">
          <span>Custom actor manifest JSON</span>
          <textarea
            className="code-editor tall"
            value={actorText}
            onChange={(event) => setActorText(event.target.value)}
          />
        </label>
        <button className="button" onClick={addActor}>
          Stage actor manifest
        </button>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Local databases</h2>
          <Database size={20} />
        </div>
        {info && (
          <div className="metadata-grid">
            <div className="key-value">
              <span>Corpus documents</span>
              <strong>{info.documents.corpus_doc_count}</strong>
            </div>
            <div className="key-value">
              <span>Corpus updates</span>
              <strong>{info.documents.update_seq}</strong>
            </div>
            <div className="key-value">
              <span>State documents</span>
              <strong>{info.state.doc_count}</strong>
            </div>
            <div className="key-value">
              <span>Adapter</span>
              <strong>{info.documents.adapter}</strong>
            </div>
          </div>
        )}
        <div className="section-subactions">
          <button className="button" onClick={installViews}>
            <RefreshCw size={15} /> Install/update map-reduce views
          </button>
          {viewStatus && <span className="muted">{viewStatus}</span>}
        </div>
      </section>
    </section>
  );
}
