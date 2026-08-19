import { standaloneHealth } from "./shared";

export const standaloneAdapter = Object.freeze({
  id: "standalone",
  label: "Standalone browser",
  workspaceLabel: "Local StarIntel workspace",
  embedded: false,
  standalone: true,
  pwa: true,
  capabilities: {
    durableWorkspace: false,
    localBrowserWorkspace: true,
    controlPlane: false,
    autoDigHost: false
  },
  health: standaloneHealth
});
