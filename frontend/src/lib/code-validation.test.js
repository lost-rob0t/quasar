import { describe, expect, it } from "vitest";
import { highlightSource, validateSource } from "./code-validation";

describe("code validation", () => {
  it("accepts balanced Common Lisp with reader forms and nested comments", () => {
    const source = `(defun demo (value)
  #| outer ( comment #| nested ) |# still comment |#
  (list #\\( #\\; "text )" |escaped(symbol)| value))`;

    expect(validateSource(source, "lisp")).toEqual({ valid: true, diagnostics: [] });
  });

  it("reports Lisp reader structure errors with locations", () => {
    const unexpected = validateSource("(list 1))", "lisp");
    expect(unexpected.valid).toBe(false);
    expect(unexpected.diagnostics[0]).toMatchObject({
      line: 1,
      column: 9,
      message: "Unexpected closing parenthesis"
    });

    const unclosed = validateSource("(defun demo ()\n  (list 1 2)", "lisp");
    expect(unclosed.valid).toBe(false);
    expect(unclosed.diagnostics[0].message).toBe("Unclosed parenthesis");

    const escapedTerminalQuote = validateSource('(list "hello\\")', "lisp");
    expect(escapedTerminalQuote.valid).toBe(false);
    expect(escapedTerminalQuote.diagnostics[0].message).toBe("Unterminated string");
  });

  it("validates JavaScript programs without executing them", () => {
    globalThis.__quasarEditorProbe = 0;
    const valid = validateSource(
      "globalThis.__quasarEditorProbe += 1; const answer = 42; void answer;",
      "javascript"
    );
    expect(valid.valid).toBe(true);
    expect(globalThis.__quasarEditorProbe).toBe(0);

    const invalid = validateSource("const = ;", "javascript");
    expect(invalid.valid).toBe(false);
    delete globalThis.__quasarEditorProbe;
  });

  it("supports actor-function expression validation", () => {
    expect(
      validateSource("(context) => ({ message: context.id })", "javascript", {
        javascriptExpression: true
      }).valid
    ).toBe(true);
    expect(
      validateSource("const value = 1;", "javascript", { javascriptExpression: true }).valid
    ).toBe(false);
  });

  it("validates JSON and emits highlighted tokens", () => {
    expect(validateSource('{"enabled": true}', "json").valid).toBe(true);
    expect(validateSource('{"enabled": }', "json").valid).toBe(false);
    expect(highlightSource("(defun hello () 42)", "lisp")).toContain("tok-keyword");
    expect(highlightSource("const answer = 42;", "javascript")).toContain("tok-keyword");
    expect(highlightSource('{"answer": 42}', "json")).toContain("tok-property");
  });
});
