const USER_NAVIGATION_GUARD_MS = 360;
const navigationStates = new WeakMap();

function pointerKey(event) {
  return Number.isFinite(event?.pointerId) ? event.pointerId : "primary";
}

export function markUserNavigation(state, now = Date.now(), duration = USER_NAVIGATION_GUARD_MS) {
  if (!state) return 0;
  state.until = Math.max(state.until || 0, now + duration);
  return state.until;
}

export function beginUserNavigation(state, pointerId = "primary") {
  if (!state) return 0;
  if (!(state.pointers instanceof Set)) state.pointers = new Set();
  state.pointers.add(pointerId);
  return state.pointers.size;
}

export function endUserNavigation(
  state,
  pointerId = "primary",
  now = Date.now(),
  duration = USER_NAVIGATION_GUARD_MS
) {
  if (!state) return 0;
  if (state.pointers instanceof Set) state.pointers.delete(pointerId);
  markUserNavigation(state, now, duration);
  return state.pointers?.size || 0;
}

export function isUserNavigationActive(state, now = Date.now()) {
  return Boolean(state && ((state.pointers?.size || 0) > 0 || now < (state.until || 0)));
}

export function isGraphUserNavigationActive(cy, now = Date.now()) {
  return isUserNavigationActive(navigationStates.get(cy), now);
}

export function installUserNavigationGuard(cy, duration = USER_NAVIGATION_GUARD_MS) {
  if (!cy || typeof cy.on !== "function") return () => {};

  const state = { until: 0, pointers: new Set() };
  const container = cy.container?.();
  const rootWindow = container?.ownerDocument?.defaultView;
  const mark = () => markUserNavigation(state, Date.now(), duration);
  const begin = (event) => beginUserNavigation(state, pointerKey(event));
  const end = (event) => endUserNavigation(state, pointerKey(event), Date.now(), duration);

  navigationStates.set(cy, state);
  cy.on("dragpan scrollzoom pinchzoom", mark);
  container?.addEventListener?.("pointerdown", begin, true);
  container?.addEventListener?.("wheel", mark, { capture: true, passive: true });
  rootWindow?.addEventListener?.("pointerup", end, true);
  rootWindow?.addEventListener?.("pointercancel", end, true);

  return () => {
    cy.off?.("dragpan scrollzoom pinchzoom", mark);
    container?.removeEventListener?.("pointerdown", begin, true);
    container?.removeEventListener?.("wheel", mark, true);
    rootWindow?.removeEventListener?.("pointerup", end, true);
    rootWindow?.removeEventListener?.("pointercancel", end, true);
    state.pointers.clear();
    if (navigationStates.get(cy) === state) navigationStates.delete(cy);
  };
}
