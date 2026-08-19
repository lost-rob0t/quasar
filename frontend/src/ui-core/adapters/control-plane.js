import { quasarHealth } from "./shared";

export const controlPlaneAdapter = Object.freeze({
  id: "control-plane",
  label: "Common Lisp Quasar",
  workspaceLabel: "StarIntel workspace",
  embedded: false,
  standalone: false,
  pwa: true,
  capabilities: {
    durableWorkspace: true,
    localBrowserWorkspace: false,
    controlPlane: true,
    autoDigHost: false
  },
  health: (state) => quasarHealth(state, { requireControlPlane: true })
});
