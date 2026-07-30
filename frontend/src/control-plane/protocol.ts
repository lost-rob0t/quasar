export const PROTOCOL_VERSION = "quasar.control.v1";

export type CommandStatus = "ok" | "error";

export interface CommandEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  command: string;
  payload: Record<string, unknown>;
  metadata: {
    client: string;
    workspace: string;
  };
}

export interface ResultEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  status: "ok";
  result: unknown;
}

export interface ErrorEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  status: "error";
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export type ResponseEnvelope = ResultEnvelope | ErrorEnvelope;

export interface EventEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  event: string;
  workspace: string;
  revision: number;
  operationId: string;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: EventEnvelope) => void;

export type CommandHandler<T = unknown> = (
  payload: Record<string, unknown>
) => Promise<T>;

export const ERROR_CODES = [
  "protocol.invalid-envelope",
  "protocol.unknown-command",
  "workspace.not-found",
  "workspace.revision-conflict",
  "document.not-found",
  "document.invalid",
  "graph.node-not-found",
  "graph.edge-not-found",
  "graph.invalid-reference",
  "transaction.failed",
  "control-plane.unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ControlPlaneError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}
