import type { EventEnvelope, EventHandler } from "./protocol";

const MAX_SEEN_OPERATIONS = 2048;
const MAX_TRANSACTION_BUFFERS = 128;

interface Subscription {
  handler: EventHandler;
  eventNames: Set<string> | null;
}

export function createEventBus(initialWorkspace = "default") {
  const subscriptions = new Map<EventHandler, Subscription>();
  const seenOperations = new Set<string>();
  const seenOrder: string[] = [];
  const revisions = new Map<string, number>();
  const transactionBuffers = new Map<string, Map<number, EventEnvelope>>();
  let activeWorkspace = initialWorkspace;

  function subscribe(handler: EventHandler, eventNames?: string[]): () => void {
    subscriptions.set(handler, {
      handler,
      eventNames: eventNames ? new Set(eventNames) : null
    });
    return () => subscriptions.delete(handler);
  }

  function remember(operationId: string): void {
    seenOperations.add(operationId);
    seenOrder.push(operationId);
    while (seenOrder.length > MAX_SEEN_OPERATIONS) {
      seenOperations.delete(seenOrder.shift()!);
    }
  }

  function deliver(event: EventEnvelope): void {
    const lastRevision = revisions.get(event.workspace) ?? 0;
    if (event.revision > lastRevision) revisions.set(event.workspace, event.revision);

    for (const subscription of subscriptions.values()) {
      if (subscription.eventNames === null || subscription.eventNames.has(event.event)) {
        try {
          subscription.handler(event);
        } catch {
          // A view subscriber cannot interrupt authoritative event delivery.
        }
      }
    }
  }

  function dispatch(event: EventEnvelope): void {
    if (event.workspace !== activeWorkspace) return;
    if (event.operationId && seenOperations.has(event.operationId)) return;
    if (event.revision < (revisions.get(event.workspace) ?? 0)) return;
    if (event.operationId) remember(event.operationId);

    if (
      event.transactionId &&
      event.eventIndex !== undefined &&
      event.eventCount !== undefined &&
      event.eventCount > 1
    ) {
      const key = `${event.workspace}:${event.transactionId}`;
      let children = transactionBuffers.get(key);
      if (!children) {
        while (transactionBuffers.size >= MAX_TRANSACTION_BUFFERS) {
          transactionBuffers.delete(transactionBuffers.keys().next().value!);
        }
        children = new Map();
        transactionBuffers.set(key, children);
      }
      children.set(event.eventIndex, event);
      if (children.size !== event.eventCount) return;
      transactionBuffers.delete(key);
      for (const child of [...children.values()].sort(
        (left, right) => left.eventIndex! - right.eventIndex!
      )) {
        deliver(child);
      }
      return;
    }

    deliver(event);
  }

  function reset(workspace = activeWorkspace): void {
    seenOperations.clear();
    seenOrder.length = 0;
    revisions.delete(workspace);
    for (const key of transactionBuffers.keys()) {
      if (key.startsWith(`${workspace}:`)) transactionBuffers.delete(key);
    }
  }

  function setWorkspace(workspace: string): void {
    activeWorkspace = workspace;
  }

  function setRevision(revision: number, workspace = activeWorkspace): void {
    revisions.set(workspace, revision);
  }

  function getRevision(workspace = activeWorkspace): number {
    return revisions.get(workspace) ?? 0;
  }

  function getSeenOperationCount(): number {
    return seenOperations.size;
  }

  return {
    subscribe,
    dispatch,
    reset,
    setWorkspace,
    setRevision,
    getRevision,
    getSeenOperationCount
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
