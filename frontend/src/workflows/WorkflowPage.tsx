import {
  Braces,
  CirclePlay,
  CircleStop,
  Download,
  Play,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deploy,
  deploymentPlan,
  applyProfile,
  loadCatalog,
  loadWorkflows,
  profilePlan,
  saveWorkflow,
  startRemote,
  stopRemote,
  validateRemote
} from "./client";
import {
  advertisedCatalog,
  connectWorkflowInput,
  descriptorForWorkflowNode,
  emptyWorkflow,
  removeWorkflowNode,
  renameWorkflowNode,
  validateWorkflow,
  workflowNodeFromDescriptor,
  workflowToLisp,
  type NodeDescriptor,
  type Workflow,
  type WorkflowNode
} from "./model";

type PendingPort = { node: string; port: string } | null;

function defaultPacketValue(port: NodeDescriptor["inputs"][number]): unknown {
  switch (port.schema?.type) {
    case "object":
      return {};
    case "array":
      return [];
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

function JsonValueEditor({
  label,
  value,
  onCommit
}: {
  label: string;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const canonical = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(canonical);
  const [valid, setValid] = useState(true);

  useEffect(() => setDraft(canonical), [canonical]);

  return (
    <textarea
      aria-label={label}
      aria-invalid={!valid}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        try {
          onCommit(JSON.parse(next));
          setValid(true);
        } catch {
          setValid(false);
        }
      }}
    />
  );
}

function download(name: string, content: string, type: string) {
  const link = document.createElement("a");
  link.download = name;
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.click();
  URL.revokeObjectURL(link.href);
}

function NodeCard({
  node,
  descriptor,
  selected,
  pending,
  onSelect,
  onMove,
  onOutput,
  onInput
}: {
  node: WorkflowNode;
  descriptor?: NodeDescriptor;
  selected: boolean;
  pending: PendingPort;
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onOutput: (port: string) => void;
  onInput: (port: string) => void;
}) {
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  return (
    <article
      className={`workflow-node${selected ? " selected" : ""}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          left: node.x,
          top: node.y
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        onSelect();
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onMove(
          Math.max(0, drag.current.left + event.clientX - drag.current.x),
          Math.max(0, drag.current.top + event.clientY - drag.current.y)
        );
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <header>
        <span>{descriptor?.category || "Unknown"}</span>
        <strong>{descriptor?.label || node.type}</strong>
        <small>{node.id}</small>
      </header>
      <div className="workflow-ports">
        <div>
          {(descriptor?.inputs || []).map((port) => (
            <button
              key={port.name}
              className="workflow-port input"
              onClick={() => onInput(port.name)}
            >
              <i /> {port.name}
            </button>
          ))}
        </div>
        <div>
          {(descriptor?.outputs || []).map((port) => (
            <button
              key={port.name}
              className={`workflow-port output${pending?.node === node.id && pending.port === port.name ? " active" : ""}`}
              onClick={() => onOutput(port.name)}
            >
              {port.name} <i />
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function WorkflowPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflow, setWorkflow] = useState<Workflow>(() => emptyWorkflow());
  const [persistedId, setPersistedId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<NodeDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPort>(null);
  const [message, setMessage] = useState("Ready");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:5000");
  const [credentialReference, setCredentialReference] = useState("credential:starintel-api");
  const [allowedOperations, setAllowedOperations] = useState("");
  const [profileShell, setProfileShell] = useState<"sh" | "bash">("sh");
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadWorkflows(), loadCatalog()])
      .then(([saved, items]) => {
        if (cancelled) return;
        setWorkflows(saved);
        setWorkflow(saved[0] || emptyWorkflow());
        setPersistedId(saved[0]?.id || null);
        setCatalog(advertisedCatalog(items));
        setMessage(saved.length ? "Loaded from workspace" : "Ready");
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const descriptors = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const filtered = useMemo(
    () =>
      catalog.filter((item) =>
        `${item.label} ${item.id} ${item.category}`.toLowerCase().includes(query.toLowerCase())
      ),
    [catalog, query]
  );
  const errors = useMemo(() => validateWorkflow(workflow, catalog), [workflow, catalog]);
  const selectedNode = workflow.nodes.find((node) => node.id === selected) || null;
  const selectedDescriptor = selectedNode
    ? descriptorForWorkflowNode(selectedNode, descriptors)
    : undefined;

  function update(recipe: (current: Workflow) => Workflow) {
    setWorkflow((current) => recipe(structuredClone(current)));
  }

  function addNode(descriptor: NodeDescriptor) {
    update((next) => {
      const base =
        descriptor.id
          .split("/")
          .at(-1)
          ?.replaceAll(/[^a-z0-9-]/gi, "-") || "node";
      let id = base;
      let number = 2;
      while (next.nodes.some((node) => node.id === id)) id = `${base}-${number++}`;
      next.nodes.push(
        workflowNodeFromDescriptor(
          descriptor,
          id,
          80 + (next.nodes.length % 4) * 230,
          80 + Math.floor(next.nodes.length / 4) * 190
        )
      );
      setSelected(id);
      return next;
    });
  }

  function connect(to: string, input: string) {
    if (!pending || pending.node === to) return;
    update((next) => {
      return connectWorkflowInput(next, pending.node, pending.port, to, input);
    });
    setPending(null);
  }

  async function save() {
    try {
      setMessage("Saving to workspace…");
      await saveWorkflow(workflow, persistedId);
      const next = [
        ...workflows.filter((item) => item.id !== persistedId && item.id !== workflow.id),
        workflow
      ];
      setWorkflows(next);
      setPersistedId(workflow.id);
      setMessage("Saved to canonical workspace");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function action(label: string, run: () => Promise<Record<string, unknown>>) {
    try {
      setMessage(`${label}…`);
      const result = await run();
      setMessage(`${label}: ${String(result.status || result.valid || "done")}`);
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  return (
    <section className="workflow-page">
      <header className="workflow-toolbar">
        <div>
          <span className="eyebrow">Morrison FBP · quasar.fbp.v1</span>
          <input
            value={workflow.id}
            onChange={(event) => update((next) => ((next.id = event.target.value), next))}
            aria-label="Workflow id"
          />
        </div>
        <label>
          <select
            value={workflow.kind}
            onChange={(event) =>
              update((next) => ((next.kind = event.target.value as Workflow["kind"]), next))
            }
          >
            <option value="workflow">Workflow</option>
            <option value="automation">Automation</option>
            <option value="actor-system">Actor system</option>
          </select>
        </label>
        <label className="workflow-toggle">
          <input
            type="checkbox"
            checked={workflow.enabledAtLogin}
            onChange={(event) =>
              update((next) => ((next.enabledAtLogin = event.target.checked), next))
            }
          />
          start at login
        </label>
        <button className="button" onClick={() => void save()}>
          <Save size={15} /> Save
        </button>
        <button
          className="button"
          onClick={() => action("Validate", () => validateRemote(workflow))}
          disabled={errors.length > 0}
        >
          <ShieldCheck size={15} /> Validate
        </button>
        <button
          className="button primary"
          onClick={() => action("Run", () => startRemote(workflow))}
          disabled={errors.length > 0}
        >
          <CirclePlay size={15} /> Run
        </button>
        <button className="button" onClick={() => action("Stop", () => stopRemote(workflow.id))}>
          <CircleStop size={15} /> Stop
        </button>
        <button className="button" onClick={() => setSourceOpen((value) => !value)}>
          <Braces size={15} /> Lisp
        </button>
      </header>

      <div className="workflow-layout">
        <aside className="workflow-palette">
          <div className="workflow-search">
            <Search size={14} />
            <input
              placeholder="Find nodes"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {[...new Set(filtered.map((item) => item.category))].map((category) => (
            <section key={category}>
              <h2>{category}</h2>
              {filtered
                .filter((item) => item.category === category)
                .map((item) => (
                  <button key={item.id} onClick={() => addNode(item)} title={item.id}>
                    <Plus size={13} />
                    <span>
                      {item.label}
                      <small>{item.id}</small>
                    </span>
                  </button>
                ))}
            </section>
          ))}
        </aside>

        <main
          className="workflow-canvas"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <svg aria-hidden="true">
            {workflow.connections.map((edge) => {
              const from = workflow.nodes.find((node) => node.id === edge.from);
              const to = workflow.nodes.find((node) => node.id === edge.to);
              if (!from || !to) return null;
              const x1 = from.x + 196,
                y1 = from.y + 82,
                x2 = to.x,
                y2 = to.y + 82;
              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} C ${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`}
                />
              );
            })}
          </svg>
          {workflow.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              descriptor={descriptorForWorkflowNode(node, descriptors)}
              selected={node.id === selected}
              pending={pending}
              onSelect={() => setSelected(node.id)}
              onMove={(x, y) =>
                update((next) => {
                  const target = next.nodes.find((item) => item.id === node.id);
                  if (target) Object.assign(target, { x, y });
                  return next;
                })
              }
              onOutput={(port) => setPending({ node: node.id, port })}
              onInput={(port) => connect(node.id, port)}
            />
          ))}
          {!workflow.nodes.length && (
            <div className="workflow-empty">
              <Play size={28} />
              <strong>Drop in a process</strong>
              <span>
                Pick a node from the palette. Click an output, then an input, to wire named ports.
              </span>
            </div>
          )}
        </main>

        <aside className="workflow-inspector">
          <h2>Inspector</h2>
          {selectedNode ? (
            <>
              <label>
                Node id
                <input
                  value={selectedNode.id}
                  onChange={(event) =>
                    update((next) => {
                      const target = next.nodes.find((node) => node.id === selectedNode.id);
                      if (target) {
                        renameWorkflowNode(next, selectedNode.id, event.target.value);
                        setSelected(event.target.value);
                      }
                      return next;
                    })
                  }
                />
              </label>
              <label>
                Configuration
                <textarea
                  value={JSON.stringify(selectedNode.config, null, 2)}
                  onChange={(event) => {
                    try {
                      const value = JSON.parse(event.target.value);
                      update((next) => {
                        const target = next.nodes.find((node) => node.id === selectedNode.id);
                        if (target) {
                          if (
                            target.type.startsWith("starintel.operation/") &&
                            typeof target.config.operation === "string"
                          ) {
                            value.operation = target.config.operation;
                          }
                          target.config = value;
                        }
                        return next;
                      });
                    } catch {
                      /* keep last valid config */
                    }
                  }}
                />
              </label>
              <h2>Initial packets</h2>
              {(selectedDescriptor?.inputs || []).map((port) => {
                const packet = workflow.iips.find(
                  (iip) => iip.to === selectedNode.id && iip.in === port.name
                );
                return (
                  <div className="workflow-iip" key={port.name}>
                    <label>
                      {port.name}
                      {packet ? (
                        <JsonValueEditor
                          label={`Initial packet for ${port.name}`}
                          value={packet.value}
                          onCommit={(value) =>
                            update((next) => {
                              const target = next.iips.find((iip) => iip.id === packet.id);
                              if (target) target.value = value;
                              return next;
                            })
                          }
                        />
                      ) : (
                        <small>No initial packet</small>
                      )}
                    </label>
                    {packet ? (
                      <button
                        className="button"
                        onClick={() =>
                          update((next) => {
                            next.iips = next.iips.filter((iip) => iip.id !== packet.id);
                            return next;
                          })
                        }
                      >
                        Remove
                      </button>
                    ) : (
                      <button
                        className="button"
                        onClick={() =>
                          update((next) => {
                            next.connections = next.connections.filter(
                              (edge) => !(edge.to === selectedNode.id && edge.in === port.name)
                            );
                            next.iips = next.iips.filter(
                              (iip) => !(iip.to === selectedNode.id && iip.in === port.name)
                            );
                            next.iips.push({
                              id: `${selectedNode.id}:${port.name}:iip`,
                              value: defaultPacketValue(port),
                              to: selectedNode.id,
                              in: port.name
                            });
                            return next;
                          })
                        }
                      >
                        Set packet
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                className="button danger"
                onClick={() =>
                  update((next) => {
                    removeWorkflowNode(next, selectedNode.id);
                    setSelected(null);
                    return next;
                  })
                }
              >
                <Trash2 size={14} /> Delete node
              </button>
            </>
          ) : (
            <p>Select a node to configure it.</p>
          )}
          <h2>Graph</h2>
          {errors.length ? (
            <ul className="workflow-errors">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : (
            <p className="workflow-valid">Graph is structurally valid.</p>
          )}
          <div className="workflow-deploy">
            <button
              className="button"
              onClick={async () =>
                setPlan(await action("Deployment plan", () => deploymentPlan(workflow)))
              }
            >
              <Download size={14} /> Dry run
            </button>
            <button
              className="button"
              onClick={() => action("Install", () => deploy(workflow))}
              disabled={!workflow.enabledAtLogin}
            >
              <Upload size={14} /> Install service
            </button>
          </div>
          <h2>StarIntel profile</h2>
          <label>
            Endpoint
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
          </label>
          <label>
            Credential reference (never the key)
            <input
              value={credentialReference}
              onChange={(event) => setCredentialReference(event.target.value)}
            />
          </label>
          <label>
            Allowed operation IDs (comma-separated)
            <input
              value={allowedOperations}
              placeholder="targets.create,documents.get"
              onChange={(event) => setAllowedOperations(event.target.value)}
            />
          </label>
          <label>
            Shell profile
            <select
              value={profileShell}
              onChange={(event) => setProfileShell(event.target.value as "sh" | "bash")}
            >
              <option value="sh">POSIX sh (.profile)</option>
              <option value="bash">Bash (.bash_profile)</option>
            </select>
          </label>
          <div className="workflow-deploy">
            <button
              className="button"
              onClick={async () =>
                setPlan(
                  await action("Profile plan", () =>
                    profilePlan(
                      endpoint,
                      credentialReference,
                      allowedOperations
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                      profileShell
                    )
                  )
                )
              }
            >
              <Download size={14} /> Preview profile
            </button>
            <button
              className="button"
              onClick={() =>
                action("Install profile", () =>
                  applyProfile(
                    endpoint,
                    credentialReference,
                    allowedOperations
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                    profileShell
                  )
                )
              }
            >
              <Upload size={14} /> Install profile
            </button>
          </div>
          <p className="workflow-status">{message}</p>
          {plan && <pre>{JSON.stringify(plan, null, 2)}</pre>}
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void file.text().then((text) => {
                  setWorkflow(JSON.parse(text) as Workflow);
                  setPersistedId(null);
                });
            }}
          />
          <button className="button" onClick={() => importRef.current?.click()}>
            <Upload size={14} /> Import JSON
          </button>
          <button
            className="button"
            onClick={() =>
              download(`${workflow.id}.json`, JSON.stringify(workflow, null, 2), "application/json")
            }
          >
            <Download size={14} /> Export JSON
          </button>
        </aside>
      </div>
      {sourceOpen && <pre className="workflow-source">{workflowToLisp(workflow)}</pre>}
    </section>
  );
}
