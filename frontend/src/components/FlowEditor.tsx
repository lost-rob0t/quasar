import { useEffect, useMemo, useRef, useState } from "react";
import {
  CATALOG,
  exampleFlow,
  isolatedJavaScriptAdapter,
  parseFlow,
  registry,
  runFlow,
  serializeFlow,
  validateCanonicalDocument,
  validateFlow,
  type Flow,
  type FlowNode,
  type RunResult
} from "../flows";
import { isJson, isObject, jsonClone } from "../flows/model";
import "../flow-editor.css";
const STORAGE_KEY = "quasar:flow-studio:v1";
function loadFlow(): { flow: Flow; notice: string } {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return { flow: saved ? parseFlow(saved) : exampleFlow(), notice: "" };
  } catch (error) {
    return { flow: exampleFlow(), notice: `Saved flow could not be loaded: ${String(error)}` };
  }
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export default function FlowEditor() {
  const [initial] = useState(loadFlow);
  const [flow, setFlow] = useState<Flow>(initial.flow);
  const [selectedId, setSelectedId] = useState(initial.flow.nodes[0]?.id || "");
  const [configText, setConfigText] = useState(
    JSON.stringify(initial.flow.nodes[0]?.config || {}, null, 2)
  );
  const [notice, setNotice] = useState(initial.notice);
  const [query, setQuery] = useState("");
  const [wireFrom, setWireFrom] = useState("");
  const [wireTo, setWireTo] = useState("");
  const [transfer, setTransfer] = useState("");
  const [jsEnabled, setJsEnabled] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const activeRun = useRef<AbortController | null>(null);
  const runEpoch = useRef(0);
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const selected = flow.nodes.find((node) => node.id === selectedId);
  let pendingSource = String(selected?.config.source || "");
  try {
    pendingSource = String(JSON.parse(configText).source || "");
  } catch {
    /* JSON diagnostics stay in the configuration editor. */
  }
  const diagnostics = useMemo(() => validateFlow(flow), [flow]);
  const catalog = CATALOG.filter((def) =>
    `${def.label} ${def.category} ${def.type}`.toLowerCase().includes(query.toLowerCase())
  );
  const hasUnappliedConfig = selected && configText !== JSON.stringify(selected.config, null, 2);
  useEffect(
    () => () => {
      runEpoch.current++;
      activeRun.current?.abort();
    },
    []
  );
  function select(node: FlowNode) {
    setSelectedId(node.id);
    setConfigText(JSON.stringify(node.config, null, 2));
  }
  function update(next: Flow) {
    setFlow(next);
    setResult(null);
    setNotice("");
  }
  function addNode(type: string) {
    if (flow.nodes.length >= 128) {
      setNotice("Node limit reached (128).");
      return;
    }
    const def = registry.get(type)!;
    const node: FlowNode = {
      id: `n-${crypto.randomUUID()}`,
      type,
      label: def.label,
      x: 40 + (flow.nodes.length % 4) * 260,
      y: 220 + Math.floor(flow.nodes.length / 4) * 180,
      config: jsonClone(def.defaults)
    };
    update({ ...flow, nodes: [...flow.nodes, node] });
    select(node);
  }
  function applyConfig() {
    try {
      const config: unknown = JSON.parse(configText);
      if (!isJson(config) || !isObject(config))
        throw new Error("Configuration must be a safe JSON object");
      const next = {
        ...flow,
        nodes: flow.nodes.map((node) =>
          node.id === selectedId ? { ...node, config: config as FlowNode["config"] } : node
        )
      };
      const errors = validateFlow(next).filter((error) => error.nodeId === selectedId);
      if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
      update(next);
      setConfigText(JSON.stringify(config, null, 2));
      setNotice("Configuration applied.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }
  function connect() {
    try {
      const from = JSON.parse(wireFrom) as { node: string; port: string };
      const to = JSON.parse(wireTo) as { node: string; port: string };
      const edge = { id: `e-${crypto.randomUUID()}`, from, to };
      const next = { ...flow, edges: [...flow.edges, edge] };
      const errors = validateFlow(next).filter(
        (error) => error.edgeId === edge.id || error.code === "cycle" || error.code === "budget"
      );
      if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
      update(next);
      setNotice("Connection added.");
    } catch (error) {
      setNotice(`Cannot connect: ${errorMessage(error)}`);
    }
  }
  async function preview() {
    const epoch = ++runEpoch.current;
    const controller = new AbortController();
    activeRun.current = controller;
    setBusy(true);
    setNotice("");
    setResult(null);
    try {
      const next = await runFlow(flow, {
        signal: controller.signal,
        validateDocument: validateCanonicalDocument,
        grants: jsEnabled ? ["code.javascript"] : [],
        adapters: jsEnabled ? { "code.javascript": isolatedJavaScriptAdapter() } : {}
      });
      if (epoch === runEpoch.current) setResult(next);
    } catch (error) {
      if (epoch === runEpoch.current) setNotice(errorMessage(error));
    } finally {
      if (epoch === runEpoch.current) {
        activeRun.current = null;
        setBusy(false);
      }
    }
  }
  const width = Math.max(1100, ...flow.nodes.map((node) => node.x + 250));
  const height = Math.max(430, ...flow.nodes.map((node) => node.y + 165));
  return (
    <section className="flow-editor" aria-label="Flow studio">
      <header className="flow-toolbar">
        <div>
          <h2>Flow studio</h2>
          <p>Build a flow, connect named ports, then preview bounded JSON messages locally.</p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button primary"
            disabled={busy || diagnostics.length > 0 || Boolean(hasUnappliedConfig)}
            onClick={preview}
          >
            Run preview
          </button>
          <button
            type="button"
            className="button"
            disabled={!busy}
            onClick={() => activeRun.current?.abort(new Error("Preview cancelled"))}
          >
            Stop
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              try {
                localStorage.setItem(STORAGE_KEY, serializeFlow(flow));
                setNotice("Flow saved in this browser.");
              } catch (error) {
                setNotice(errorMessage(error));
              }
            }}
          >
            Save flow
          </button>
        </div>
      </header>
      <label className="flow-name">
        Flow name
        <input
          value={flow.name}
          disabled={busy}
          onChange={(event) => update({ ...flow, name: event.target.value })}
        />
      </label>
      <p className="flow-boundary">
        Local preview · 128 nodes · 2,048 messages · 10 seconds. Transport, server and
        Lisp/Prolog/StarLang nodes require trusted host adapters and are disabled here. Existing
        RabbitMQ ingestion remains in Settings.
      </p>
      <label className="flow-js-optin">
        <input
          type="checkbox"
          checked={jsEnabled}
          disabled={busy}
          onChange={(event) => setJsEnabled(event.target.checked)}
        />{" "}
        Enable isolated JavaScript for this session (no network or workspace capabilities)
      </label>
      <div className="flow-layout">
        <aside className="flow-palette" aria-label="Node palette">
          <label>
            Find nodes
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="map, StarIntel, TCP…"
            />
          </label>
          {catalog.map((def) => (
            <button
              type="button"
              key={def.type}
              disabled={busy}
              onClick={() => addNode(def.type)}
              title={def.help}
            >
              <span>{def.label}</span>
              <small>
                {def.category}
                {def.adapter ? " · adapter" : ""}
              </small>
            </button>
          ))}
        </aside>
        <div className="flow-main">
          <div className="flow-canvas-scroll" aria-label="Flow canvas">
            <div className="flow-canvas" style={{ width, height }}>
              <svg className="flow-wires" width={width} height={height} aria-hidden="true">
                {flow.edges.map((edge) => {
                  const from = flow.nodes.find((node) => node.id === edge.from.node);
                  const to = flow.nodes.find((node) => node.id === edge.to.node);
                  if (!from || !to) return null;
                  return (
                    <path
                      key={edge.id}
                      d={`M ${from.x + 220} ${from.y + 60} C ${from.x + 270} ${from.y + 60}, ${to.x - 50} ${to.y + 60}, ${to.x} ${to.y + 60}`}
                    />
                  );
                })}
              </svg>
              {flow.nodes.map((node) => {
                const def = registry.get(node.type)!;
                return (
                  <div
                    key={node.id}
                    className={`flow-node ${node.id === selectedId ? "selected" : ""}`}
                    style={{ left: node.x, top: node.y }}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      className="flow-node-title"
                      aria-pressed={node.id === selectedId}
                      onClick={() => select(node)}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        drag.current = {
                          id: node.id,
                          x: event.clientX,
                          y: event.clientY,
                          originX: node.x,
                          originY: node.y
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        const start = drag.current;
                        if (!start || start.id !== node.id) return;
                        const x = Math.max(
                          0,
                          Math.min(5000, start.originX + event.clientX - start.x)
                        );
                        const y = Math.max(
                          0,
                          Math.min(5000, start.originY + event.clientY - start.y)
                        );
                        setFlow((current) => ({
                          ...current,
                          nodes: current.nodes.map((item) =>
                            item.id === node.id ? { ...item, x, y } : item
                          )
                        }));
                      }}
                      onPointerUp={() => {
                        drag.current = null;
                      }}
                      onPointerCancel={() => {
                        drag.current = null;
                      }}
                    >
                      {node.label}
                      <small>{def.type}</small>
                    </button>
                    <div className="flow-ports">
                      <div>
                        {Object.entries(def.inputs).map(([port, type]) => (
                          <button
                            key={port}
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              select(node);
                              setWireTo(JSON.stringify({ node: node.id, port }));
                            }}
                            title={`Input ${type}`}
                          >
                            ● {port}
                          </button>
                        ))}
                      </div>
                      <div>
                        {Object.entries(def.outputs).map(([port, type]) => (
                          <button
                            key={port}
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              select(node);
                              setWireFrom(JSON.stringify({ node: node.id, port }));
                            }}
                            title={`Output ${type}`}
                          >
                            {port} ●
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <section className="flow-connections" aria-label="Connections">
            <h3>Connections</h3>
            <div className="flow-connect-form">
              <label>
                From output
                <select
                  value={wireFrom}
                  disabled={busy}
                  onChange={(event) => setWireFrom(event.target.value)}
                >
                  <option value="">Select output</option>
                  {flow.nodes.flatMap((node) =>
                    Object.keys(registry.get(node.type)!.outputs).map((port) => (
                      <option
                        key={`${node.id}:${port}`}
                        value={JSON.stringify({ node: node.id, port })}
                      >
                        {node.label} · {port}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label>
                To input
                <select
                  value={wireTo}
                  disabled={busy}
                  onChange={(event) => setWireTo(event.target.value)}
                >
                  <option value="">Select input</option>
                  {flow.nodes.flatMap((node) =>
                    Object.keys(registry.get(node.type)!.inputs).map((port) => (
                      <option
                        key={`${node.id}:${port}`}
                        value={JSON.stringify({ node: node.id, port })}
                      >
                        {node.label} · {port}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                className="button"
                type="button"
                disabled={busy || !wireFrom || !wireTo}
                onClick={connect}
              >
                Connect
              </button>
            </div>
            <ul>
              {flow.edges.map((edge) => (
                <li key={edge.id}>
                  <span>
                    {flow.nodes.find((node) => node.id === edge.from.node)?.label} ·{" "}
                    {edge.from.port} → {flow.nodes.find((node) => node.id === edge.to.node)?.label}{" "}
                    · {edge.to.port}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove connection ${edge.id}`}
                    onClick={() =>
                      update({ ...flow, edges: flow.edges.filter((item) => item.id !== edge.id) })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="flow-inspector" aria-label="Node inspector">
          {selected ? (
            <>
              <h3>{selected.label}</h3>
              <p>{registry.get(selected.type)?.help}</p>
              <label>
                Node label
                <input
                  disabled={busy}
                  value={selected.label}
                  onChange={(event) =>
                    update({
                      ...flow,
                      nodes: flow.nodes.map((node) =>
                        node.id === selectedId ? { ...node, label: event.target.value } : node
                      )
                    })
                  }
                />
              </label>
              <div className="flow-coordinates">
                {(["x", "y"] as const).map((axis) => (
                  <label key={axis}>
                    {axis.toUpperCase()}
                    <input
                      type="number"
                      min="0"
                      max="5000"
                      disabled={busy}
                      value={selected[axis]}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value))
                          update({
                            ...flow,
                            nodes: flow.nodes.map((node) =>
                              node.id === selectedId
                                ? { ...node, [axis]: Math.max(0, Math.min(5000, value)) }
                                : node
                            )
                          });
                      }}
                    />
                  </label>
                ))}
              </div>
              <label>
                Configuration JSON
                <textarea
                  aria-label="Configuration JSON"
                  spellCheck={false}
                  rows={12}
                  value={configText}
                  disabled={busy}
                  onChange={(event) => setConfigText(event.target.value)}
                />
              </label>
              {hasUnappliedConfig && <p>Apply configuration before running.</p>}
              {selected.type.startsWith("code.") && (
                <label>
                  Node source
                  <textarea
                    aria-label="Node source"
                    spellCheck={false}
                    rows={10}
                    disabled={busy}
                    value={pendingSource}
                    onChange={(event) =>
                      setConfigText(
                        JSON.stringify({ ...selected.config, source: event.target.value }, null, 2)
                      )
                    }
                  />
                </label>
              )}
              <div className="button-row">
                <button className="button" type="button" disabled={busy} onClick={applyConfig}>
                  Apply configuration
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const next = {
                      ...flow,
                      nodes: flow.nodes.filter((node) => node.id !== selectedId),
                      edges: flow.edges.filter(
                        (edge) => edge.from.node !== selectedId && edge.to.node !== selectedId
                      )
                    };
                    update(next);
                    setSelectedId("");
                    setConfigText("{}");
                  }}
                >
                  Delete node
                </button>
              </div>
              <p className="flow-node-id">{selected.id}</p>
            </>
          ) : (
            <p>Select a node to edit its configuration.</p>
          )}
        </aside>
      </div>
      <div className="flow-status" role="status" aria-live="polite">
        {busy
          ? "Preview running…"
          : notice ||
            (diagnostics.length
              ? `${diagnostics.length} validation issue(s)`
              : "Flow valid. JSON output types are checked at runtime before delivery.")}
      </div>
      {diagnostics.length > 0 && (
        <ul className="flow-errors">
          {diagnostics.map((error, index) => (
            <li key={index}>
              {error.nodeId || error.edgeId}: {error.message}
            </li>
          ))}
        </ul>
      )}
      {result && (
        <section className="flow-result" aria-label="Preview results">
          <h3>Preview {result.status}</h3>
          {result.error && <p role="alert">{result.error}</p>}
          <p>
            {result.steps} delivery steps · {result.trace.length} trace entries
          </p>
          <ol>
            {result.trace.map((entry, index) => (
              <li key={index}>
                <strong>
                  {flow.nodes.find((node) => node.id === entry.nodeId)?.label} · {entry.port} ·{" "}
                  {entry.kind}
                </strong>
                <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
              </li>
            ))}
          </ol>
        </section>
      )}
      <details className="flow-transfer">
        <summary>Import / export flow JSON</summary>
        <p>Version 1 Quasar format. Paste, import, then save. Never include credentials.</p>
        <label>
          Flow JSON
          <textarea
            rows={12}
            spellCheck={false}
            value={transfer}
            disabled={busy}
            onChange={(event) => setTransfer(event.target.value)}
          />
        </label>
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              try {
                setTransfer(serializeFlow(flow));
                setNotice("Flow JSON ready to copy.");
              } catch (error) {
                setNotice(errorMessage(error));
              }
            }}
          >
            Export JSON
          </button>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => {
              try {
                const next = parseFlow(transfer);
                update(next);
                setWireFrom("");
                setWireTo("");
                if (next.nodes[0]) select(next.nodes[0]);
                else {
                  setSelectedId("");
                  setConfigText("{}");
                }
                setNotice("Flow imported; save to retain it.");
              } catch (error) {
                setNotice(`Import failed: ${errorMessage(error)}`);
              }
            }}
          >
            Import JSON
          </button>
        </div>
      </details>
    </section>
  );
}
