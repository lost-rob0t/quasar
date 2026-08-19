import { autoDigHealth } from "./shared";

export const autoDigAdapter = Object.freeze({
  id: "auto-dig",
  label: "Auto-Dig embedded",
  workspaceLabel: "Auto-Dig investigation",
  embedded: true,
  standalone: false,
  pwa: false,
  capabilities: {
    durableWorkspace: true,
    localBrowserWorkspace: false,
    controlPlane: true,
    autoDigHost: true
  },
  health: autoDigHealth
});
