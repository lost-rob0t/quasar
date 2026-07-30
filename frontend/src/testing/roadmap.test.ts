import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import roadmap from "../../docs/roadmap.json";

interface RoadmapIssue {
  number: number;
  dependsOn: number[];
}

const issues: RoadmapIssue[] = roadmap.phases.flatMap((phase) => phase.issues);
const issueNumbers = issues.map((issue) => issue.number);

describe("deployment roadmap", () => {
  it("contains every linked implementation issue exactly once", () => {
    expect(roadmap.schemaVersion).toBe(1);
    expect(roadmap.parentIssue).toBe(2);
    expect(roadmap.phases.map((phase) => phase.number)).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...issueNumbers].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 3)
    );
    expect(new Set(issueNumbers).size).toBe(issueNumbers.length);
    expect(roadmap.phases.every((phase) => phase.exitGate.trim().length > 0)).toBe(true);
  });

  it("is an acyclic dependency graph whose dependencies precede their consumers", () => {
    const knownIssues = new Set(issueNumbers);
    const completed = new Set<number>();

    for (const issue of issues) {
      expect(new Set(issue.dependsOn).size).toBe(issue.dependsOn.length);
      expect(issue.dependsOn).not.toContain(issue.number);

      for (const dependency of issue.dependsOn) {
        expect(knownIssues.has(dependency)).toBe(true);
        expect(completed.has(dependency)).toBe(true);
      }

      completed.add(issue.number);
    }
  });

  it("documents every issue and the immutable deployment constraints", async () => {
    const document = await readFile(new URL("../../docs/ROADMAP.md", import.meta.url), "utf8");

    for (const issueNumber of issueNumbers) {
      expect(document).toContain(`https://github.com/lost-rob0t/quasar-ui/issues/${issueNumber}`);
    }

    for (const requiredDecision of [
      "TypeScript, React, and Vite",
      "IndexedDB is the only canonical local workspace store",
      "Cytoscape.js is accessible only through a strict graph adapter",
      "Web Workers",
      "XState",
      "TanStack Query",
      "static, installable PWA",
      "no deployment path through a Common Lisp backend",
      "Rust or Tauri",
      "GraphQL",
      "Socket.IO",
      "Release promotion uses one immutable artifact"
    ]) {
      expect(document).toContain(requiredDecision);
    }
  });
});
