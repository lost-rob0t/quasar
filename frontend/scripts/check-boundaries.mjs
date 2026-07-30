import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ZONES = [
  "app",
  "core",
  "storage",
  "graph",
  "actions",
  "projections",
  "integrations",
  "components",
  "testing"
];

const ALLOWED_DEPENDENCIES = {
  app: new Set([
    "core",
    "storage",
    "graph",
    "actions",
    "projections",
    "integrations",
    "components"
  ]),
  core: new Set(),
  storage: new Set(["core"]),
  graph: new Set(["core"]),
  actions: new Set(["core"]),
  projections: new Set(["core"]),
  integrations: new Set(["core", "actions"]),
  components: new Set(["core", "graph", "actions", "projections"]),
  testing: new Set(ZONES)
};

const CORE_PLATFORM_IMPORTS = new Set([
  "react",
  "react-dom",
  "react-router-dom",
  "cytoscape",
  "cytoscape-edgehandles",
  "pouchdb-browser",
  "@stomp/stompjs"
]);

const RENDERER_IMPORTS = new Set(["cytoscape", "cytoscape-edgehandles"]);
const GRAPH_ADAPTER = "src/graph/GraphAdapter.js";

function normalizeSourcePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function zoneFor(sourcePath) {
  const normalized = normalizeSourcePath(sourcePath);
  const match = /^src\/([^/]+)(?:\/|$)/.exec(normalized);
  return match && ZONES.includes(match[1]) ? match[1] : null;
}

function resolvedImportPath(fromPath, specifier) {
  if (!specifier.startsWith(".")) return null;
  return normalizeSourcePath(
    path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier))
  );
}

export function validateImport(fromPath, specifier) {
  const normalizedFrom = normalizeSourcePath(fromPath);
  const fromZone = zoneFor(normalizedFrom);
  if (!fromZone) return null;

  if (fromZone === "core" && CORE_PLATFORM_IMPORTS.has(specifier)) {
    return `core must remain platform-independent and cannot import ${specifier}`;
  }

  if (RENDERER_IMPORTS.has(specifier) && normalizedFrom !== GRAPH_ADAPTER) {
    return `${specifier} may only be imported by ${GRAPH_ADAPTER}`;
  }

  const targetPath = resolvedImportPath(normalizedFrom, specifier);
  if (!targetPath) return null;
  const targetZone = zoneFor(targetPath);

  if (targetZone && targetZone !== fromZone && !ALLOWED_DEPENDENCIES[fromZone].has(targetZone)) {
    return `${fromZone} cannot depend on ${targetZone}`;
  }

  if (
    targetPath.startsWith("src/lib/") &&
    /\.tsx?$/.test(normalizedFrom) &&
    fromZone !== "app" &&
    path.posix.basename(normalizedFrom) !== "index.ts"
  ) {
    return `legacy src/lib modules may only be bridged by a package index`;
  }

  return null;
}

export function importSpecifiers(source) {
  const specifiers = [];
  const staticImports = /(?:import|export)\s+(?:[^"'\`;]*?\sfrom\s*)?["']([^"']+)["']/g;
  const dynamicImports = /import\(\s*["']([^"']+)["']\s*\)/g;

  for (const expression of [staticImports, dynamicImports]) {
    for (const match of source.matchAll(expression)) specifiers.push(match[1]);
  }

  return specifiers;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute);
      return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
    })
  );
  return nested.flat();
}

export async function checkSourceTree(rootDirectory = process.cwd()) {
  const files = await sourceFiles(path.join(rootDirectory, "src"));
  const violations = [];

  for (const absolute of files) {
    const relative = normalizeSourcePath(path.relative(rootDirectory, absolute));
    const source = await readFile(absolute, "utf8");

    for (const specifier of importSpecifiers(source)) {
      const message = validateImport(relative, specifier);
      if (message) violations.push({ file: relative, specifier, message });
    }
  }

  return violations;
}

const invokedAsScript =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  const violations = await checkSourceTree();

  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.message} (${violation.specifier})`);
    }
    process.exitCode = 1;
  } else {
    console.log("Package boundary check passed.");
  }
}
