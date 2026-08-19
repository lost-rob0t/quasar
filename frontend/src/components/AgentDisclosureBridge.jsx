import { useEffect } from "react";

function isDisclosure(entry) {
  return entry?.matches?.(
    ".agent-log-entry.tool, .agent-log-entry.model, .agent-log-entry.thinking, .agent-log-entry.reasoning"
  );
}

function label(entry) {
  const heading = entry.querySelector(":scope > strong")?.textContent?.trim();
  return entry.classList.contains("tool") ? heading || "Tool run" : "Agent thinking";
}

function prepare(entry) {
  if (!isDisclosure(entry)) return;
  if (!entry.dataset.expanded) entry.dataset.expanded = "false";
  entry.classList.add("agent-log-collapsible");
  entry.tabIndex = 0;
  entry.setAttribute("role", "button");
  entry.setAttribute("aria-expanded", entry.dataset.expanded);
  entry.setAttribute(
    "aria-label",
    `${entry.dataset.expanded === "true" ? "Collapse" : "Expand"} ${label(entry)}`
  );
}

function prepareAll() {
  document
    .querySelectorAll(
      ".agent-log-entry.tool, .agent-log-entry.model, .agent-log-entry.thinking, .agent-log-entry.reasoning"
    )
    .forEach(prepare);
}

function toggle(entry) {
  const expanded = entry.dataset.expanded !== "true";
  entry.dataset.expanded = String(expanded);
  entry.setAttribute("aria-expanded", String(expanded));
  entry.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${label(entry)}`);
}

export default function AgentDisclosureBridge() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        prepareAll();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();

    const click = (event) => {
      const entry = event.target.closest?.(".agent-log-entry");
      if (!isDisclosure(entry) || event.target.closest("pre")) return;
      toggle(entry);
    };
    const keydown = (event) => {
      const entry = event.target.closest?.(".agent-log-entry");
      if (!isDisclosure(entry) || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      toggle(entry);
    };
    document.addEventListener("click", click);
    document.addEventListener("keydown", keydown);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", keydown);
    };
  }, []);

  return null;
}
