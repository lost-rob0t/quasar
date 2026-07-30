import { useEffect, useMemo, useState } from "react";
import { KeyRound, Play, RefreshCw, Save, Settings2, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import {
  actorConfigurationDefinition,
  clearActorConfiguration,
  isMelissaActor,
  loadActorConfiguration,
  saveActorConfiguration
} from "../lib/actor-configuration";
import { installMelissaActorPack, MELISSA_ACTORS } from "../lib/melissa-actor-installation";
import { testMelissaPersonatorSearch } from "../lib/melissa-personator-test";
import { useQuasar } from "../store";

function actorSettingsPanel() {
  return (
    [...document.querySelectorAll("section.panel")].find((section) =>
      section
        .querySelector(":scope > .section-heading > h2")
        ?.textContent?.trim()
        .startsWith("Browser actors")
    ) || null
  );
}

function createHost(panel) {
  if (!panel) return null;
  const existing = panel.querySelector(":scope > .actor-configuration-host");
  if (existing) return existing;
  const host = document.createElement("div");
  host.className = "actor-configuration-host";
  const actorList = panel.querySelector(":scope > .actor-list");
  panel.insertBefore(host, actorList || null);
  return host;
}

function fieldValue(event, field) {
  if (field.type === "number") {
    return event.target.value === "" ? "" : Number(event.target.value);
  }
  return event.target.value;
}

function MelissaFields({
  actor,
  form,
  installed,
  onChange,
  onSave,
  onClear,
  onInstall,
  onTest,
  testing,
  testResult
}) {
  const definition = actorConfigurationDefinition(actor);
  const primary = definition.fields.slice(0, 9);
  const advanced = definition.fields.slice(9);

  const renderField = (field) => (
    <label
      className={
        field.key === "licenseKey" || field.key === "proxyTemplate" ? "field full" : "field"
      }
      key={field.key}
    >
      <span>
        {field.label}
        {field.required ? " *" : ""}
      </span>
      {field.type === "select" ? (
        <select
          value={form[field.key] ?? ""}
          onChange={(event) => onChange(field.key, fieldValue(event, field))}
        >
          {(field.options || []).map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "secret" ? "password" : field.type === "number" ? "number" : "text"}
          min={field.min}
          max={field.max}
          value={form[field.key] ?? ""}
          placeholder={field.placeholder || ""}
          autoComplete={field.type === "secret" ? "off" : undefined}
          onChange={(event) => onChange(field.key, fieldValue(event, field))}
        />
      )}
    </label>
  );

  return (
    <div className="actor-config-group">
      <div className="section-heading">
        <div>
          <h3>
            <KeyRound size={16} /> {definition.label}
          </h3>
          <p className="muted">{definition.description}</p>
        </div>
        <div className="connection-badges">
          <span className={`sync-badge sync-${installed ? "active" : "offline"}`}>
            {installed ? "pack installed" : "pack not installed"}
          </span>
          <span
            className={`sync-badge sync-${
              String(form.licenseKey || "").trim() ? "active" : "offline"
            }`}
          >
            {String(form.licenseKey || "").trim() ? "configured" : "license key required"}
          </span>
        </div>
      </div>
      <div className="form-grid">{primary.map(renderField)}</div>
      <div className="actor-config-test">
        <p>
          <strong>Place the key in the first field above.</strong> Copy the value from Melissa
          Account → License Information → <strong>License Key Using Credits</strong>. Paste only the
          key value, not the label.
        </p>
        <p className="muted">
          The test is manual. It sends Melissa&apos;s documented sample person and address directly
          to Personator Search and may consume credits.
        </p>
        <button
          className="button"
          type="button"
          onClick={onTest}
          disabled={testing || !String(form.licenseKey || "").trim()}
        >
          <Play size={15} />{" "}
          {testing ? "Testing Personator Search…" : "Save and test Personator Search"}
        </button>
        {testResult && (
          <div
            className={testResult.ok ? "actor-test-result" : "actor-test-result validation-error"}
          >
            <strong>
              {testResult.ok ? "Personator credential accepted" : "Personator credential rejected"}
            </strong>
            <dl>
              <div>
                <dt>HTTP</dt>
                <dd>{testResult.httpStatus}</dd>
              </div>
              <div>
                <dt>TransmissionResults</dt>
                <dd>{testResult.transmissionResults}</dd>
              </div>
              <div>
                <dt>Records</dt>
                <dd>{testResult.totalRecords}</dd>
              </div>
              <div>
                <dt>Saved key</dt>
                <dd>
                  {testResult.key.length} characters · ends in {testResult.key.ending || "(empty)"}{" "}
                  · fingerprint {testResult.key.fingerprint || "(empty)"}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
      <details className="actor-config-advanced">
        <summary>Advanced Melissa options</summary>
        <div className="form-grid">{advanced.map(renderField)}</div>
      </details>
      <div className="button-row">
        <button className="button primary" type="button" onClick={onSave}>
          <Save size={15} /> Save Melissa configuration
        </button>
        <button className="button" type="button" onClick={onInstall}>
          <RefreshCw size={15} /> {installed ? "Refresh actor pack" : "Install actor pack"}
        </button>
        <button className="button danger" type="button" onClick={onClear}>
          <Trash2 size={15} /> Clear Melissa configuration
        </button>
      </div>
    </div>
  );
}

export default function ActorConfigurationBridge() {
  const location = useLocation();
  const { actors = [], settings, persistSettings, setNotice } = useQuasar();
  const [host, setHost] = useState(null);
  const [melissaForm, setMelissaForm] = useState({});
  const [melissaTest, setMelissaTest] = useState(null);
  const [testingMelissa, setTestingMelissa] = useState(false);
  const [selectedActorId, setSelectedActorId] = useState("");
  const [jsonText, setJsonText] = useState("{}");

  const installedMelissaActor = useMemo(() => actors.find(isMelissaActor) || null, [actors]);
  const melissaActor = installedMelissaActor || MELISSA_ACTORS[0];
  const melissaInstalled = Boolean(installedMelissaActor);
  const ordinaryActors = useMemo(() => actors.filter((actor) => !isMelissaActor(actor)), [actors]);
  const selectedActor = useMemo(
    () => ordinaryActors.find((actor) => actor.id === selectedActorId) || ordinaryActors[0] || null,
    [ordinaryActors, selectedActorId]
  );

  useEffect(() => {
    if (location.pathname !== "/settings") {
      setHost(null);
      return undefined;
    }
    const sync = () => setHost(createHost(actorSettingsPanel()));
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => observer.disconnect();
  }, [location.pathname]);

  useEffect(
    () => () => {
      if (host?.isConnected) host.remove();
    },
    [host]
  );

  useEffect(() => {
    setMelissaForm(loadActorConfiguration(melissaActor));
    setMelissaTest(null);
  }, [melissaActor]);

  useEffect(() => {
    if (!selectedActor) {
      setSelectedActorId("");
      setJsonText("{}");
      return;
    }
    if (selectedActor.id !== selectedActorId) {
      setSelectedActorId(selectedActor.id);
    }
    setJsonText(JSON.stringify(loadActorConfiguration(selectedActor), null, 2));
  }, [selectedActor, selectedActorId]);

  function saveMelissa() {
    try {
      const saved = saveActorConfiguration(melissaActor, melissaForm);
      setMelissaForm(saved);
      setMelissaTest(null);
      setNotice({
        kind: "success",
        message: "Melissa actor configuration saved locally"
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  async function testMelissa() {
    setTestingMelissa(true);
    setMelissaTest(null);
    try {
      const saved = saveActorConfiguration(melissaActor, melissaForm);
      setMelissaForm(saved);
      const result = await testMelissaPersonatorSearch(saved.licenseKey);
      setMelissaTest(result);
      setNotice({
        kind: result.ok ? "success" : "error",
        message: result.ok
          ? `Personator Search accepted the saved key (${result.transmissionResults})`
          : `Personator Search rejected the exact saved key (${result.transmissionResults})`
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    } finally {
      setTestingMelissa(false);
    }
  }

  function clearMelissa() {
    clearActorConfiguration(melissaActor);
    setMelissaForm(loadActorConfiguration(melissaActor));
    setMelissaTest(null);
    setNotice({
      kind: "success",
      message: "Melissa actor configuration cleared"
    });
  }

  async function installMelissa() {
    try {
      await persistSettings(installMelissaActorPack(settings || {}));
      setNotice({
        kind: "success",
        message: melissaInstalled ? "Melissa actor pack refreshed" : "Melissa actor pack installed"
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function chooseActor(event) {
    setSelectedActorId(event.target.value);
  }

  function saveJson() {
    if (!selectedActor) return;
    try {
      const parsed = JSON.parse(jsonText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("Actor configuration must be a JSON object");
      }
      const saved = saveActorConfiguration(selectedActor, parsed);
      setJsonText(JSON.stringify(saved, null, 2));
      setNotice({
        kind: "success",
        message: `Configuration saved for ${selectedActor.label}`
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
    }
  }

  function clearJson() {
    if (!selectedActor) return;
    clearActorConfiguration(selectedActor);
    setJsonText("{}");
    setNotice({
      kind: "success",
      message: `Configuration cleared for ${selectedActor.label}`
    });
  }

  if (location.pathname !== "/settings" || !host) return null;

  return createPortal(
    <div className="actor-configuration-panel">
      <div className="section-heading">
        <div>
          <h2>
            <Settings2 size={18} /> Actor configuration
          </h2>
          <p className="muted">
            Configuration stays in this browser and is passed to actor code as{" "}
            <code>context.configuration</code>. It is not included in settings exports.
          </p>
        </div>
      </div>

      <MelissaFields
        actor={melissaActor}
        form={melissaForm}
        installed={melissaInstalled}
        onChange={(key, value) => {
          setMelissaForm((current) => ({ ...current, [key]: value }));
          setMelissaTest(null);
        }}
        onSave={saveMelissa}
        onClear={clearMelissa}
        onInstall={installMelissa}
        onTest={testMelissa}
        testing={testingMelissa}
        testResult={melissaTest}
      />

      <div className="actor-config-group">
        <div className="section-heading">
          <div>
            <h3>Other actor configuration</h3>
            <p className="muted">Store arbitrary JSON for bundled or custom actors.</p>
          </div>
        </div>
        <label className="field">
          <span>Actor</span>
          <select
            value={selectedActor?.id || ""}
            onChange={chooseActor}
            disabled={!ordinaryActors.length}
          >
            {ordinaryActors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.label} — {actor.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Configuration JSON</span>
          <textarea
            className="code-editor"
            rows={8}
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
            disabled={!selectedActor}
          />
        </label>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={saveJson}
            disabled={!selectedActor}
          >
            <Save size={15} /> Save actor configuration
          </button>
          <button
            className="button danger"
            type="button"
            onClick={clearJson}
            disabled={!selectedActor}
          >
            <Trash2 size={15} /> Clear
          </button>
        </div>
      </div>
    </div>,
    host
  );
}
