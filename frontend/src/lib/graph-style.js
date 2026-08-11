export const GRAPH_STYLE = [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      shape: "data(shape)",
      label: "data(label)",
      color: "#e5eef9",
      "font-size": 11,
      "font-weight": 600,
      "text-wrap": "ellipsis",
      "text-max-width": 130,
      "text-valign": "bottom",
      "text-margin-y": 8,
      width: 38,
      height: 38,
      "border-width": 2,
      "border-color": "#07111f",
      "overlay-padding": 8
    }
  },
  {
    selector: "node[dtype = 'research-node']",
    style: {
      label: "data(researchLabel)",
      width: 54,
      height: 54,
      "text-wrap": "wrap",
      "text-max-width": 150,
      "border-width": 4
    }
  },
  {
    selector: "node[dtype = 'research-node'][researchStatus = 'running']",
    style: { "border-color": "#22c55e" }
  },
  {
    selector: "node[dtype = 'research-node'][researchStatus = 'paused']",
    style: { "border-color": "#f59e0b", "border-style": "dashed" }
  },
  {
    selector: "node[dtype = 'research-node'][researchStatus = 'blocked']",
    style: { "border-color": "#f59e0b", "border-style": "double" }
  },
  {
    selector: "node[dtype = 'research-node'][researchStatus = 'completed']",
    style: { "border-color": "#38bdf8" }
  },
  {
    selector: "node[dtype = 'research-node'][researchStatus = 'failed']",
    style: { "border-color": "#ef4444", "border-style": "dashed" }
  },
  {
    selector: "node[dtype = 'research-node'][researchStatus = 'killed']",
    style: { opacity: 0.58, "border-style": "dotted" }
  },
  { selector: "node[?unresolved]", style: { "border-style": "dashed", opacity: 0.72 } },
  {
    selector: "node:selected",
    style: {
      "border-color": "#f8fafc",
      "border-width": 4,
      "underlay-color": "#38bdf8",
      "underlay-opacity": 0.18,
      "underlay-padding": 10
    }
  },
  { selector: "node.path", style: { "border-color": "#f59e0b", "border-width": 5 } },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#46617f",
      "target-arrow-color": "#46617f",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      label: "data(label)",
      color: "#8fa5bc",
      "font-size": 8,
      "text-background-color": "#07111f",
      "text-background-opacity": 0.85,
      "text-background-padding": 2,
      "text-rotation": "autorotate",
      "arrow-scale": 0.75
    }
  },
  { selector: "edge[!directed]", style: { "target-arrow-shape": "none" } },
  {
    selector: "edge:selected",
    style: { width: 3, "line-color": "#38bdf8", "target-arrow-color": "#38bdf8" }
  },
  {
    selector: "edge.path",
    style: { width: 4, "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", "z-index": 20 }
  },
  {
    selector: ".eh-handle",
    style: {
      width: 13,
      height: 13,
      shape: "ellipse",
      "background-color": "#38bdf8",
      "border-width": 2,
      "border-color": "#e0f2fe",
      "overlay-opacity": 0
    }
  },
  { selector: ".eh-source", style: { "border-color": "#38bdf8", "border-width": 4 } },
  { selector: ".eh-target, .eh-hover", style: { "border-color": "#22c55e", "border-width": 4 } },
  {
    selector: ".eh-preview, .eh-ghost-edge",
    style: {
      width: 2,
      "line-color": "#38bdf8",
      "target-arrow-color": "#38bdf8",
      "target-arrow-shape": "triangle",
      "line-style": "dashed"
    }
  },
  { selector: ".labels-hidden", style: { label: "" } }
];

const THEME_COLOR = {
  "#e5eef9": "--text",
  "#07111f": "--bg-deep",
  "#f8fafc": "--white",
  "#38bdf8": "--accent",
  "#f59e0b": "--warning",
  "#46617f": "--line",
  "#8fa5bc": "--muted",
  "#e0f2fe": "--white",
  "#22c55e": "--success",
  "#ef4444": "--danger"
};

export function themedGraphStyle(root = document.documentElement) {
  const tokens = getComputedStyle(root);
  return GRAPH_STYLE.map((rule) => ({
    ...rule,
    style: Object.fromEntries(
      Object.entries(rule.style).map(([property, value]) => {
        const token = THEME_COLOR[value];
        return [property, token ? tokens.getPropertyValue(token).trim() || value : value];
      })
    )
  }));
}
