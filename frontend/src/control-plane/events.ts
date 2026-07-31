import type { EventEnvelope, EventHandler } from "./protocol";

type Unsubscribe = () => void;

interface Subscription {
  handler: EventHandler;
  eventNames: Set<string> | null;
}

export function createEventBus() {
  const subscriptions = new Map<EventHandler, Subscription>();
  const seenOperations = new Set<string>();
  let lastRevision = 0;

  function subscribe(handler: EventHandler, eventNames?: string[]): Unsubscribe {
    const sub: Subscription = {
      handler,
      eventNames: eventNames ? new Set(eventNames) : null,
    };
    subscriptions.set(handler, sub);
    return () => {
      subscriptions.delete(handler);
    };
  }

  function dispatch(event: EventEnvelope): void {
    if (event.operationId && seenOperations.has(event.operationId)) {
      return;
    }
    if (event.operationId) {
      seenOperations.add(event.operationId);
    }
    if (event.revision && event.revision < lastRevision) {
      return;
    }
    if (event.revision && event.revision > lastRevision) {
      lastRevision = event.revision;
    }
    for (const sub of subscriptions.values()) {
      if (sub.eventNames === null || sub.eventNames.has(event.event)) {
        try {
          sub.handler(event);
        } catch {
          // Handler errors must not break the dispatch loop.
        }
      }
    }
  }

  function reset(): void {
    subscriptions.clear();
    seenOperations.clear();
    lastRevision = 0;
  }

  function setRevision(rev: number): void {
    lastRevision = rev;
  }

  function getRevision(): number {
    return lastRevision;
  }

  return { subscribe, dispatch, reset, setRevision, getRevision };
}

export type EventBus = ReturnType<typeof createEventBus>;
