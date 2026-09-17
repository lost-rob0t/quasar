import { useState } from "react";
import { Play, ShieldCheck, SquareTerminal } from "lucide-react";
import { codeBlockRunnable, codeRuntime, runCodeBlock } from "../lib/code-block-runner";

export default function ExecutableCodeBlock({ language = "text", source = "" }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const runnable = codeBlockRunnable(language);
  const runtime = codeRuntime(language);

  async function run() {
    if (!runnable || running) return;
    setRunning(true);
    try {
      setResult(await runCodeBlock({ language, source }));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="doc-code-block">
      <header className="doc-code-toolbar">
        <span className="doc-code-language">
          <SquareTerminal size={14} />
          {language || "text"}
        </span>
        <span className="doc-code-runtime">
          <ShieldCheck size={13} />
          {runtime || "read-only"}
        </span>
        <button
          type="button"
          className="button compact"
          disabled={!runnable || running}
          onClick={run}
          title={runnable ? "Run in the bounded local sandbox" : "No sandbox runtime enabled"}
        >
          <Play size={13} />
          {running ? "Running…" : "Run"}
        </button>
      </header>
      <pre>
        <code>{source}</code>
      </pre>
      {result ? (
        <div className={`doc-code-output ${result.ok ? "ok" : "error"}`}>
          {result.stdout ? (
            <pre aria-label="Standard output">
              <code>{result.stdout}</code>
            </pre>
          ) : null}
          {result.result && result.result !== "undefined" ? (
            <pre aria-label="Result">
              <code>{result.result}</code>
            </pre>
          ) : null}
          {result.stderr ? (
            <pre aria-label="Standard error">
              <code>{result.stderr}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
