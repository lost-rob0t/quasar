#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(repoRoot, "frontend", "public", "quasar-docs");
const indexPath = path.join(outputRoot, "index.json");
const allowedExtensions = new Set([".md", ".org", ".txt"]);
const starIntelManifestPath = path.join(repoRoot, "vendor-docs", "starintel-server", "MANIFEST.json");

const roots = [
  { id: "quasar-docs", label: "Quasar docs", root: path.join(repoRoot, "docs") },
  { id: "quasar-wiki", label: "Operator wiki", root: path.join(repoRoot, "wiki") },
  { id: "quasar-learn", label: "Learn", root: path.join(repoRoot, "learn") }
];

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "result") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, absolute)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    files.push({ absolute, relative: path.relative(root, absolute) });
  }
  return files;
}

function titleFromSource(source, fallback) {
  const orgTitle = source.match(/^#\+title:\s*(.+)$/im)?.[1]?.trim();
  if (orgTitle) return orgTitle;
  const markdownTitle = source.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (markdownTitle) return markdownTitle;
  return fallback.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
}

function summaryFromSource(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("#") &&
        !line.startsWith("*") &&
        !line.startsWith("#+") &&
        !line.startsWith("```")
    )
    .join(" ")
    .slice(0, 220);
}

function safeFileName(id) {
  const readable = id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${readable}-${digest}.txt`;
}

async function loadStarIntelManifest() {
  if (!(await exists(starIntelManifestPath))) return null;
  const manifest = JSON.parse(await fs.readFile(starIntelManifestPath, "utf8"));
  if (!manifest?.revision || !manifest?.rawBase || !Array.isArray(manifest.documents)) {
    throw new Error("Invalid StarIntel documentation manifest");
  }
  return manifest;
}

async function main() {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(outputRoot, "source"), { recursive: true });

  const documents = [];
  for (const sourceRoot of roots) {
    if (!(await exists(sourceRoot.root))) continue;
    const files = await walk(sourceRoot.root);
    for (const file of files) {
      const source = await fs.readFile(file.absolute, "utf8");
      const id = `${sourceRoot.id}/${file.relative.split(path.sep).join("/")}`;
      const asset = `source/${safeFileName(id)}`;
      await fs.writeFile(path.join(outputRoot, asset), source, "utf8");
      documents.push({
        id,
        section: sourceRoot.id,
        sectionLabel: sourceRoot.label,
        path: file.relative.split(path.sep).join("/"),
        title: titleFromSource(source, path.basename(file.relative)),
        summary: summaryFromSource(source),
        format: path.extname(file.relative).slice(1).toLowerCase(),
        asset: `/quasar-docs/${asset}`,
        remote: false
      });
    }
  }

  const starIntelManifest = await loadStarIntelManifest();
  if (starIntelManifest) {
    for (const document of starIntelManifest.documents) {
      const relativePath = String(document.path || "").replace(/^\/+/, "");
      if (!relativePath) continue;
      documents.push({
        id: `starintel-server/${relativePath}`,
        section: "starintel-server",
        sectionLabel: "StarIntel Server",
        path: relativePath,
        title: document.title || relativePath,
        summary: `Pinned StarIntel Server documentation at ${starIntelManifest.revision.slice(0, 12)}.`,
        format: path.extname(relativePath).slice(1).toLowerCase(),
        asset: new URL(relativePath, starIntelManifest.rawBase).href,
        remote: true,
        revision: starIntelManifest.revision
      });
    }
  }

  documents.sort((a, b) =>
    a.section === b.section ? a.path.localeCompare(b.path) : a.section.localeCompare(b.section)
  );

  await fs.writeFile(
    indexPath,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        sourceRevisions: { starintelServer: starIntelManifest?.revision || null },
        documents
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Packaged ${documents.length} documentation entries into ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
