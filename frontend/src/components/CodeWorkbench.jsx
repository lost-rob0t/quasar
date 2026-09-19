import { useEffect, useMemo, useState } from "react";
import { Braces, Code2, Copy, RotateCcw } from "lucide-react";
import CodeEditor from "./CodeEditor";
import "../code-workbench.css";

const DEFAULT_BUFFERS = Object.freeze({
  lisp: `(defun selected-target-ids (targets)
  (loop for target in targets
        for id = (getf target :id)
        when id
          collect id))
`,
  javascript: `function selectedTargetIds(targets) {
  return targets
    .map((target) => target?.id)
    .filter(Boolean);
}
`
});

const MODES = Object.freeze([
  {
    id: "lisp",
    label: "Common Lisp",
    description: "Common Lisp / StarLang-oriented source",
    Icon: Braces
  },
  {
    id: "javascript",
    label: "JavaScript",
    description: "Browser and Quasar JavaScript source",
    Icon: Code2
  }
]);

function loadBuffer(mode) {
  try {
    return globalThis.localStorage?.getItem(`quasar:code-studio:${mode}`) ?? DEFAULT_BUFFERS[mode];
  } catch {
    return DEFAULT_BUFFERS[mode];
  }
}

export default function CodeWorkbench() {
  const [mode, setMode] = useState("lisp");
  const [buffers, setBuffers] = useState(() => ({
    lisp: loadBuffer("lisp"),
    javascript: loadBuffer("javascript")
  }));
  const [notice, setNotice] = useState("");
  const activeMode = useMemo(() => MODES.find((entry) => entry.id === mode) || MODES[0], [mode]);
  const source = buffers[mode];

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(`quasar:code-studio:${mode}`, source);
    } catch {
      // Browser storage is optional; the editor still works without persistence.
    }
  }, [mode, source]);

  function updateSource(next) {
    setBuffers((current) => ({ ...current, [mode]: next }));
    setNotice("");
  }

  async function copySource() {
    try {
      await globalThis.navigator?.clipboard?.writeText(source);
      setNotice("Copied source to clipboard.");
    } catch {
      setNotice("Clipboard access is unavailable in this browser context.");
    }
  }

  function resetSource() {
    setBuffers((current) => ({ ...current, [mode]: DEFAULT_BUFFERS[mode] }));
    setNotice(`${activeMode.label} buffer reset.`);
  }

  return (
    <section className="code-workbench page-stack">
      <header className="page-heading code-workbench-heading">
        <div>
          <p className="eyebrow">Developer tools</p>
          <h1>Code studio</h1>
          <p>
            Edit Common Lisp / StarLang-oriented source and JavaScript with live highlighting and
            syntax validation. Execution remains behind Quasar&apos;s existing runtime capability
            boundaries.
          </p>
        </div>
        <div className="button-row">
          <button className="button" type="button" onClick={copySource}>
            <Copy size={15} /> Copy source
          </button>
          <button className="button" type="button" onClick={resetSource}>
            <RotateCcw size={15} /> Reset buffer
          </button>
        </div>
      </header>

      <section className="panel code-workbench-panel">
        <div className="code-language-tabs" role="tablist" aria-label="Editor language">
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              className={mode === id ? "active" : ""}
              onClick={() => {
                setMode(id);
                setNotice("");
              }}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="code-workbench-context">
          <div>
            <strong>{activeMode.label}</strong>
            <span>{activeMode.description}</span>
          </div>
          <span>Autosaved locally</span>
        </div>

        <CodeEditor
          value={source}
          onChange={updateSource}
          language={mode}
          ariaLabel={`${activeMode.label} source editor`}
          minHeight={560}
        />

        {notice && (
          <div className="code-workbench-notice" role="status">
            {notice}
          </div>
        )}
      </section>
    </section>
  );
}
