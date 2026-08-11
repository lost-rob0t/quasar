const BASE_DELAY = 500;
const MAX_DELAY = 30_000;
const JITTER = 0.3;

export interface ReconnectState {
  attempts: number;
  delay: number;
  connected: boolean;
}

export function createReconnectManager(
  onReconnect: () => void,
  onStateChange: (state: ReconnectState) => void
) {
  const state: ReconnectState = { attempts: 0, delay: BASE_DELAY, connected: true };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped || timer !== null) return;
    state.attempts += 1;
    const jitter = 1 + (Math.random() - 0.5) * JITTER;
    state.delay = Math.min(BASE_DELAY * Math.pow(2, state.attempts - 1) * jitter, MAX_DELAY);
    onStateChange({ ...state });
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      onReconnect();
    }, state.delay);
  }

  function markConnected(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    state.connected = true;
    state.attempts = 0;
    state.delay = BASE_DELAY;
    onStateChange({ ...state });
  }

  function markDisconnected(): void {
    state.connected = false;
    onStateChange({ ...state });
    scheduleReconnect();
  }

  function stop(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function start(): void {
    stopped = false;
  }

  return {
    scheduleReconnect,
    markConnected,
    markDisconnected,
    stop,
    start,
    get state() {
      return state;
    }
  };
}

export type ReconnectManager = ReturnType<typeof createReconnectManager>;
