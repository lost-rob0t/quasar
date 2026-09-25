import { useMemo, useRef } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { highlightSource, validateSource } from "../lib/code-validation";
import "../code-editor.css";

const INDENT = "  ";

function languageLabel(language) {
  switch (language) {
    case "lisp":
    case "common-lisp":
      return "Common Lisp";
    case "starlang":
      return "StarLang / Lisp";
    case "json":
      return "JSON";
    case "javascript":
    case "js":
    default:
      return "JavaScript";
  }
}

function validationOptions(validationMode) {
  return validationMode === "expression" ? { javascriptExpression: true } : {};
}

function indentValue(value, start, end, outdent = false) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const selectionEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEndMatch = value.indexOf("\n", selectionEnd);
  const blockEnd = lineEndMatch === -1 ? value.length : lineEndMatch;
  const block = value.slice(lineStart, blockEnd);
  const lines = block.split("\n");

  if (outdent) {
    let removedBeforeStart = 0;
    let removedTotal = 0;
    const transformed = lines.map((line, index) => {
      const removed = line.startsWith(INDENT) ? INDENT.length : line.startsWith(" ") ? 1 : 0;
      if (index === 0) removedBeforeStart = Math.min(removed, start - lineStart);
      removedTotal += removed;
      return line.slice(removed);
    });
    return {
      value: `${value.slice(0, lineStart)}${transformed.join("\n")}${value.slice(blockEnd)}`,
      start: Math.max(lineStart, start - removedBeforeStart),
      end: Math.max(lineStart, end - removedTotal)
    };
  }

  if (start === end) {
    return {
      value: `${value.slice(0, start)}${INDENT}${value.slice(end)}`,
      start: start + INDENT.length,
      end: start + INDENT.length
    };
  }

  const transformed = lines.map((line) => `${INDENT}${line}`).join("\n");
  return {
    value: `${value.slice(0, lineStart)}${transformed}${value.slice(blockEnd)}`,
    start: start + INDENT.length,
    end: end + INDENT.length * lines.length
  };
}

export default function CodeEditor({
  value,
  onChange,
  language = "javascript",
  validationMode = "program",
  readOnly = false,
  ariaLabel,
  minHeight = 520
}) {
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const gutterRef = useRef(null);
  const source = String(value || "");
  const highlighted = useMemo(() => highlightSource(source, language), [source, language]);
  const validation = useMemo(
    () => validateSource(source, language, validationOptions(validationMode)),
    [source, language, validationMode]
  );
  const lineCount = source.split("\n").length;
  const lines = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount]
  );
  const firstDiagnostic = validation.diagnostics[0] || null;

  function syncScroll(event) {
    const { scrollLeft, scrollTop } = event.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollLeft = scrollLeft;
      highlightRef.current.scrollTop = scrollTop;
    }
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-scrollTop}px)`;
  }

  function handleKeyDown(event) {
    if (readOnly || event.key !== "Tab") return;
    event.preventDefault();
    const target = event.currentTarget;
    const next = indentValue(source, target.selectionStart, target.selectionEnd, event.shiftKey);
    onChange?.(next.value);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.selectionStart = next.start;
      textareaRef.current.selectionEnd = next.end;
    });
  }

  const diagnosticLocation =
    firstDiagnostic?.line && firstDiagnostic?.column
      ? `line ${firstDiagnostic.line}, col ${firstDiagnostic.column}: `
      : "";

  return (
    <div className={`code-editor-shell${readOnly ? " read-only" : ""}`}>
      <div className="code-editor-frame" style={{ minHeight }}>
        <div className="code-editor-gutter" aria-hidden="true">
          <pre ref={gutterRef}>{lines}</pre>
        </div>
        <div className="code-editor-body">
          <pre
            ref={highlightRef}
            className="code-editor-highlight"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }}
          />
          <textarea
            ref={textareaRef}
            className="code-editor-input"
            value={source}
            readOnly={readOnly}
            spellCheck="false"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={ariaLabel || `${languageLabel(language)} editor`}
            onScroll={syncScroll}
            onKeyDown={handleKeyDown}
            onChange={(event) => onChange?.(event.target.value)}
          />
        </div>
      </div>
      <footer className={`code-editor-status${validation.valid ? " valid" : " invalid"}`}>
        <span className="code-editor-language">{languageLabel(language)}</span>
        <span>{lineCount.toLocaleString()} lines</span>
        <span className="code-editor-validation" role="status">
          {validation.valid ? (
            <>
              <CheckCircle2 size={14} aria-hidden="true" /> Syntax valid
            </>
          ) : (
            <>
              <CircleAlert size={14} aria-hidden="true" />
              {diagnosticLocation}
              {firstDiagnostic?.message || "Syntax error"}
            </>
          )}
        </span>
      </footer>
    </div>
  );
}
