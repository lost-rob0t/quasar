import { Client } from "@stomp/stompjs";

export function documentsFromQueuePayload(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.documents)) return parsed.documents;
  if (parsed?.document) return [parsed.document];
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("Queue delivery must contain a StarIntel document or document batch");
}

export function startRabbitMqIngest(configuration, handlers = {}) {
  const brokerURL = String(configuration?.rabbitWebSocketUrl || "").trim();
  const destination = String(configuration?.rabbitDestination || "").trim();
  if (!brokerURL) throw new Error("RabbitMQ Web STOMP URL is required");
  if (!destination) throw new Error("RabbitMQ STOMP destination is required");

  const client = new Client({
    brokerURL,
    connectHeaders: {
      login: configuration.rabbitUsername || "guest",
      passcode: configuration.rabbitPassword || "guest",
      host: configuration.rabbitVhost || "/"
    },
    heartbeatIncoming: 10_000,
    heartbeatOutgoing: 10_000,
    reconnectDelay: 5_000,
    connectionTimeout: 10_000,
    debug: configuration.rabbitDebug ? (message) => handlers.onDebug?.(message) : () => {}
  });

  client.onConnect = () => {
    handlers.onStatus?.({ state: "active", message: `Listening on ${destination}` });
    client.subscribe(
      destination,
      async (message) => {
        try {
          const documents = documentsFromQueuePayload(message.body);
          const result = await handlers.onDocuments?.(documents, {
            messageId: message.headers["message-id"] || message.headers["amqp-message-id"] || null,
            destination,
            headers: message.headers
          });
          message.ack();
          handlers.onDelivery?.({ state: "accepted", count: result?.count ?? documents.length });
        } catch (error) {
          message.nack({ requeue: "false" });
          handlers.onDelivery?.({ state: "rejected", count: 0, error: error.message });
          handlers.onError?.(error);
        }
      },
      {
        ack: "client-individual",
        "prefetch-count": String(configuration.rabbitPrefetch || 25),
        ...(configuration.rabbitQueueName ? { "x-queue-name": configuration.rabbitQueueName } : {})
      }
    );
  };
  client.onStompError = (frame) => {
    const error = new Error(frame.headers.message || frame.body || "RabbitMQ STOMP error");
    handlers.onStatus?.({ state: "error", message: error.message });
    handlers.onError?.(error);
  };
  client.onWebSocketError = () => {
    handlers.onStatus?.({ state: "retrying", message: "RabbitMQ WebSocket connection failed" });
  };
  client.onWebSocketClose = () => {
    handlers.onStatus?.({ state: "offline", message: "RabbitMQ listener stopped" });
  };
  handlers.onStatus?.({ state: "connecting", message: "Connecting to RabbitMQ Web STOMP" });
  client.activate();

  return {
    client,
    cancel() {
      return client.deactivate();
    }
  };
}
