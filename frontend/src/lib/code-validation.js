const LISP_KEYWORDS = new Set([
  "and",
  "block",
  "case",
  "catch",
  "cond",
  "defclass",
  "defconstant",
  "defgeneric",
  "define-condition",
  "defmacro",
  "defmethod",
  "defpackage",
  "defparameter",
  "defstruct",
  "deftype",
  "defun",
  "defvar",
  "do",
  "do*",
  "dolist",
  "dotimes",
  "ecase",
  "etypecase",
  "eval-when",
  "flet",
  "function",
  "go",
  "handler-bind",
  "handler-case",
  "if",
  "labels",
  "lambda",
  "let",
  "let*",
  "locally",
  "loop",
  "macrolet",
  "multiple-value-bind",
  "multiple-value-call",
  "multiple-value-prog1",
  "or",
  "prog1",
  "progn",
  "progv",
  "quote",
  "restart-case",
  "return-from",
  "setq",
  "symbol-macrolet",
  "tagbody",
  "the",
  "throw",
  "typecase",
  "unless",
  "unwind-protect",
  "when"
]);

const LISP_BUILTINS = new Set([
  "assert",
  "car",
  "cdr",
  "cons",
  "error",
  "find",
  "format",
  "getf",
  "length",
  "list",
  "map",
  "mapcar",
  "nil",
  "not",
  "remove",
  "setf",
  "t",
  "values"
]);

const JS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

const JS_CONSTANTS = new Set(["false", "Infinity", "NaN", "null", "true", "undefined"]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function token(kind, value) {
  return `<span class="tok-${kind}">${escapeHtml(value)}</span>`;
}

function locationFor(source, index) {
  const safeIndex = Math.max(0, Math.min(Number(index) || 0, source.length));
  const before = source.slice(0, safeIndex);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: safeIndex - lastBreak };
}

function diagnostic(source, index, message) {
  return { ...locationFor(source, index), message };
}

function result(diagnostics = []) {
  return { valid: diagnostics.length === 0, diagnostics };
}

function scanLispString(source, start, terminator = '"') {
  let index = start + 1;
  let escaped = false;
  while (index < source.length) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === terminator) return { index: index + 1, closed: true };
    index += 1;
  }
  return { index: source.length, closed: false };
}

function scanLispBlockComment(source, start) {
  let index = start + 2;
  let depth = 1;
  while (index < source.length && depth > 0) {
    if (source.startsWith("#|", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (source.startsWith("|#", index)) {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return { index, depth };
}

function scanLispCharacter(source, start) {
  let index = start + 2;
  if (index >= source.length) return index;

  const character = source[index];
  if (/\s/.test(character) || "()\"';`,|".includes(character)) return index + 1;

  while (index < source.length && !/[\s()";'`,|]/.test(source[index])) index += 1;
  return index;
}

function highlightLisp(source) {
  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source.startsWith("#|", index)) {
      const scanned = scanLispBlockComment(source, index);
      output += token("comment", source.slice(index, scanned.index));
      index = scanned.index;
      continue;
    }
    if (source.startsWith("#\\", index)) {
      const end = scanLispCharacter(source, index);
      output += token("constant", source.slice(index, end));
      index = end;
      continue;
    }

    const character = source[index];
    if (character === ";") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      output += token("comment", source.slice(index, stop));
      index = stop;
      continue;
    }
    if (character === '"') {
      const scanned = scanLispString(source, index);
      output += token("string", source.slice(index, scanned.index));
      index = scanned.index;
      continue;
    }
    if (character === "|") {
      const scanned = scanLispString(source, index, "|");
      output += token("symbol", source.slice(index, scanned.index));
      index = scanned.index;
      continue;
    }
    if (/\s/.test(character)) {
      output += character;
      index += 1;
      continue;
    }
    if ("()'`,".includes(character)) {
      output += token("reader", character);
      index += 1;
      continue;
    }

    const endMatch = source.slice(index).search(/[\s()";'`,|]/);
    const end = endMatch === -1 ? source.length : index + endMatch;
    const value = source.slice(index, end || index + 1);
    const normalized = value.toLowerCase();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdDfFlLsS][+-]?\d+)?$/.test(value)) {
      output += token("number", value);
    } else if (value.startsWith(":")) {
      output += token("constant", value);
    } else if (LISP_KEYWORDS.has(normalized)) {
      output += token("keyword", value);
    } else if (LISP_BUILTINS.has(normalized)) {
      output += token("function", value);
    } else {
      output += token("symbol", value);
    }
    index = end || index + 1;
  }

  return output;
}

function scanJavaScriptString(source, start, quote) {
  let index = start + 1;
  let escaped = false;
  while (index < source.length) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function highlightJavaScript(source) {
  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      output += token("comment", source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += token("comment", source.slice(index, stop));
      index = stop;
      continue;
    }

    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      const end = scanJavaScriptString(source, index, character);
      output += token("string", source.slice(index, end));
      index = end;
      continue;
    }
    if (/\s/.test(character)) {
      output += character;
      index += 1;
      continue;
    }

    const numberMatch = source
      .slice(index)
      .match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/);
    if (numberMatch) {
      output += token("number", numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = source.slice(index).match(/^[$A-Za-z_][$\w]*/);
    if (identifierMatch) {
      const value = identifierMatch[0];
      const rest = source.slice(index + value.length);
      if (JS_KEYWORDS.has(value)) output += token("keyword", value);
      else if (JS_CONSTANTS.has(value)) output += token("constant", value);
      else if (/^\s*\(/.test(rest)) output += token("function", value);
      else output += escapeHtml(value);
      index += value.length;
      continue;
    }

    output += escapeHtml(character);
    index += 1;
  }

  return output;
}

function highlightJson(source) {
  let output = "";
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const end = scanJavaScriptString(source, index, character);
      const value = source.slice(index, end);
      const rest = source.slice(end);
      output += token(/^\s*:/.test(rest) ? "property" : "string", value);
      index = end;
      continue;
    }
    if (/\s/.test(character)) {
      output += character;
      index += 1;
      continue;
    }
    const numberMatch = source
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      output += token("number", numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    const constantMatch = source.slice(index).match(/^(?:true|false|null)\b/);
    if (constantMatch) {
      output += token("constant", constantMatch[0]);
      index += constantMatch[0].length;
      continue;
    }
    output += escapeHtml(character);
    index += 1;
  }

  return output;
}

export function highlightSource(source, language) {
  const text = String(source || "");
  switch (language) {
    case "lisp":
    case "common-lisp":
    case "starlang":
      return highlightLisp(text);
    case "json":
      return highlightJson(text);
    case "javascript":
    case "js":
    default:
      return highlightJavaScript(text);
  }
}

function validateLisp(source) {
  const stack = [];
  let index = 0;

  while (index < source.length) {
    if (source.startsWith("#|", index)) {
      const scanned = scanLispBlockComment(source, index);
      if (scanned.depth > 0) {
        return result([diagnostic(source, index, "Unterminated block comment")]);
      }
      index = scanned.index;
      continue;
    }
    if (source.startsWith("#\\", index)) {
      index = scanLispCharacter(source, index);
      continue;
    }

    const character = source[index];
    if (character === ";") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === '"' || character === "|") {
      const scanned = scanLispString(source, index, character);
      if (!scanned.closed) {
        return result([
          diagnostic(
            source,
            index,
            character === '"' ? "Unterminated string" : "Unterminated escaped symbol"
          )
        ]);
      }
      index = scanned.index;
      continue;
    }
    if (character === "(") stack.push(index);
    else if (character === ")") {
      if (!stack.length) {
        return result([diagnostic(source, index, "Unexpected closing parenthesis")]);
      }
      stack.pop();
    }
    index += 1;
  }

  if (stack.length) {
    const openIndex = stack.at(-1);
    return result([diagnostic(source, openIndex, "Unclosed parenthesis")]);
  }
  return result();
}

function validateJavaScript(source, { javascriptExpression = false } = {}) {
  try {
    if (javascriptExpression) {
      Function(`"use strict";\nreturn (\n${source}\n);`);
    } else {
      Function(`"use strict";\n${source}\n`);
    }
    return result();
  } catch (error) {
    return result([{ line: null, column: null, message: error?.message || "Invalid JavaScript" }]);
  }
}

function validateJson(source) {
  try {
    JSON.parse(source);
    return result();
  } catch (error) {
    const message = error?.message || "Invalid JSON";
    const explicit = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (explicit) {
      return result([{ line: Number(explicit[1]), column: Number(explicit[2]), message }]);
    }
    const position = message.match(/position\s+(\d+)/i);
    if (position) {
      return result([diagnostic(source, Number(position[1]), message)]);
    }
    return result([{ line: null, column: null, message }]);
  }
}

export function validateSource(source, language, options = {}) {
  const text = String(source || "");
  switch (language) {
    case "lisp":
    case "common-lisp":
    case "starlang":
      return validateLisp(text);
    case "json":
      return validateJson(text);
    case "javascript":
    case "js":
    default:
      return validateJavaScript(text, options);
  }
}
