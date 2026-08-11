import { describe, expect, it } from "vitest";
import { filterAgentChats } from "./agent-chat-search";

const runs = [
  {
    id: "run-alpha",
    goal: "Map Acme leadership",
    status: "paused",
    agentId: "researcher",
    dataset: "acme"
  },
  {
    id: "run-beta",
    goal: "Scrape council calendar",
    status: "running",
    agentId: "web-operator",
    dataset: "columbus"
  }
];

describe("filterAgentChats", () => {
  it("returns chats in their existing recency order when the search is blank", () => {
    expect(filterAgentChats(runs, "")).toEqual(runs);
  });

  it("searches goal, run metadata, and multiple terms case-insensitively", () => {
    expect(filterAgentChats(runs, "ACME paused")).toEqual([runs[0]]);
    expect(filterAgentChats(runs, "web running")).toEqual([runs[1]]);
    expect(filterAgentChats(runs, "run-beta")).toEqual([runs[1]]);
  });

  it("returns no chats when every term cannot be satisfied", () => {
    expect(filterAgentChats(runs, "acme running")).toEqual([]);
  });
});
