import {
  applyGraphCommand,
  type GraphCommand,
  type GraphCommandEffects,
  type GraphCommandIssue
} from "./graph-commands";
import {
  cloneGraphDocument,
  validateGraphDocument,
  type CanonicalGraphDocument,
  type GraphValidationIssue
} from "./graph-document";
import { defaultTypeRegistry, type TypeRegistry } from "./type-registry";

export const DEFAULT_GRAPH_HISTORY_LIMIT = 100;

export interface GraphTransactionRecord {
  id: string;
  label: string;
  timestamp: string;
  baseRevision: number;
  committedRevision: number;
  command: GraphCommand;
  effects: GraphCommandEffects;
  before: CanonicalGraphDocument;
  after: CanonicalGraphDocument;
}

export interface GraphHistoryState {
  graph: CanonicalGraphDocument;
  revision: number;
  limit: number;
  undoStack: GraphTransactionRecord[];
  redoStack: GraphTransactionRecord[];
}

export interface CreateGraphHistoryOptions {
  revision?: number;
  limit?: number;
  registry?: TypeRegistry;
}

export interface CommitGraphTransactionOptions {
  expectedRevision?: number;
  transactionId?: string;
  label?: string;
  timestamp?: string;
  registry?: TypeRegistry;
}

export interface GraphHistoryOperationOptions {
  expectedRevision?: number;
}

export type GraphHistoryAction = "commit" | "redo" | "undo";

export type GraphHistoryRejectionCode =
  "command-rejected" | "empty-transaction" | "history-empty" | "invalid-history" | "stale-revision";

export interface GraphHistoryIssue {
  code: GraphHistoryRejectionCode;
  path: string;
  message: string;
  commandErrors?: GraphCommandIssue[];
  validation?: GraphValidationIssue[];
}

export interface GraphHistorySuccess {
  ok: true;
  action: GraphHistoryAction;
  state: GraphHistoryState;
  transaction: GraphTransactionRecord;
}

export interface GraphHistoryRejection {
  ok: false;
  action: GraphHistoryAction;
  state: GraphHistoryState;
  errors: GraphHistoryIssue[];
}

export type GraphHistoryResult = GraphHistorySuccess | GraphHistoryRejection;

export class GraphHistoryStateError extends Error {
  readonly errors: GraphHistoryIssue[];

  constructor(errors: GraphHistoryIssue[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    this.name = "GraphHistoryStateError";
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
}

function validateRevision(value: unknown, path: string): GraphHistoryIssue[] {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return [
      {
        code: "invalid-history",
        path,
        message: "must be a non-negative safe integer"
      }
    ];
  }
  return [];
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_GRAPH_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new GraphHistoryStateError([
      {
        code: "invalid-history",
        path: "limit",
        message: "must be a non-negative safe integer"
      }
    ]);
  }
  return limit;
}

function trimStack(stack: GraphTransactionRecord[], limit: number): GraphTransactionRecord[] {
  if (limit === 0) return [];
  return stack.length <= limit ? stack : stack.slice(stack.length - limit);
}

function cloneTransaction(transaction: GraphTransactionRecord): GraphTransactionRecord {
  return {
    ...transaction,
    command: cloneValue(transaction.command),
    effects: cloneValue(transaction.effects),
    before: cloneGraphDocument(transaction.before),
    after: cloneGraphDocument(transaction.after)
  };
}

function cloneStack(stack: readonly GraphTransactionRecord[]): GraphTransactionRecord[] {
  return stack.map(cloneTransaction);
}

function reject(
  state: GraphHistoryState,
  action: GraphHistoryAction,
  errors: GraphHistoryIssue[]
): GraphHistoryRejection {
  return { ok: false, action, state, errors };
}

function expectedRevisionError(
  state: GraphHistoryState,
  expectedRevision: number | undefined
): GraphHistoryIssue[] {
  if (expectedRevision === undefined) return [];
  const invalid = validateRevision(expectedRevision, "expectedRevision");
  if (invalid.length) return invalid;
  if (expectedRevision !== state.revision) {
    return [
      {
        code: "stale-revision",
        path: "expectedRevision",
        message: `expected revision ${expectedRevision}, current revision is ${state.revision}`
      }
    ];
  }
  return [];
}

function assertRevisionCanAdvance(state: GraphHistoryState): GraphHistoryIssue[] {
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    return [
      {
        code: "invalid-history",
        path: "revision",
        message: "cannot advance beyond Number.MAX_SAFE_INTEGER"
      }
    ];
  }
  return [];
}

function validateState(state: GraphHistoryState, registry: TypeRegistry): GraphHistoryIssue[] {
  const errors = [
    ...validateRevision(state.revision, "revision"),
    ...validateRevision(state.limit, "limit")
  ];
  const graph = validateGraphDocument(state.graph, registry);
  if (!graph.valid) {
    errors.push({
      code: "invalid-history",
      path: "graph",
      message: "history graph is invalid",
      validation: graph.errors
    });
  }
  if (!Array.isArray(state.undoStack)) {
    errors.push({
      code: "invalid-history",
      path: "undoStack",
      message: "must be an array"
    });
  }
  if (!Array.isArray(state.redoStack)) {
    errors.push({
      code: "invalid-history",
      path: "redoStack",
      message: "must be an array"
    });
  }
  return errors;
}

function commandForTransaction(
  commandOrCommands: GraphCommand | readonly GraphCommand[],
  options: CommitGraphTransactionOptions
): GraphCommand | null {
  if (!Array.isArray(commandOrCommands)) return cloneValue(commandOrCommands as GraphCommand);
  if (!commandOrCommands.length) return null;
  return {
    type: "batch",
    commands: commandOrCommands.map((command) => cloneValue(command)),
    ...(options.label ? { label: options.label } : {}),
    ...(options.timestamp ? { timestamp: options.timestamp } : {})
  };
}

function transactionTimestamp(
  command: GraphCommand,
  options: CommitGraphTransactionOptions
): string {
  return options.timestamp ?? command.timestamp ?? new Date().toISOString();
}

function transactionLabel(command: GraphCommand, options: CommitGraphTransactionOptions): string {
  if (options.label?.trim()) return options.label.trim();
  if (command.type === "batch" && command.label?.trim()) return command.label.trim();
  return command.type;
}

export function createGraphHistoryState(
  graph: CanonicalGraphDocument,
  options: CreateGraphHistoryOptions = {}
): GraphHistoryState {
  const registry = options.registry ?? defaultTypeRegistry;
  const revision = options.revision ?? 0;
  const limit = normalizeLimit(options.limit);
  const state: GraphHistoryState = {
    graph: cloneGraphDocument(graph),
    revision,
    limit,
    undoStack: [],
    redoStack: []
  };
  const errors = validateState(state, registry);
  if (errors.length) throw new GraphHistoryStateError(errors);
  return state;
}

export function cloneGraphHistoryState(state: GraphHistoryState): GraphHistoryState {
  return {
    graph: cloneGraphDocument(state.graph),
    revision: state.revision,
    limit: state.limit,
    undoStack: cloneStack(state.undoStack),
    redoStack: cloneStack(state.redoStack)
  };
}

export function commitGraphTransaction(
  state: GraphHistoryState,
  commandOrCommands: GraphCommand | readonly GraphCommand[],
  options: CommitGraphTransactionOptions = {}
): GraphHistoryResult {
  const registry = options.registry ?? defaultTypeRegistry;
  const stateErrors = validateState(state, registry);
  if (stateErrors.length) return reject(state, "commit", stateErrors);
  const stale = expectedRevisionError(state, options.expectedRevision);
  if (stale.length) return reject(state, "commit", stale);
  const overflow = assertRevisionCanAdvance(state);
  if (overflow.length) return reject(state, "commit", overflow);

  const command = commandForTransaction(commandOrCommands, options);
  if (!command) {
    return reject(state, "commit", [
      {
        code: "empty-transaction",
        path: "commands",
        message: "a transaction requires at least one graph command"
      }
    ]);
  }

  const applied = applyGraphCommand(state.graph, command, registry);
  if (!applied.ok) {
    return reject(state, "commit", [
      {
        code: "command-rejected",
        path: "command",
        message: "graph command was rejected",
        commandErrors: applied.errors
      }
    ]);
  }

  const revision = state.revision + 1;
  const timestamp = transactionTimestamp(command, options);
  const transaction: GraphTransactionRecord = {
    id: options.transactionId ?? `transaction:${revision}`,
    label: transactionLabel(command, options),
    timestamp,
    baseRevision: state.revision,
    committedRevision: revision,
    command: cloneValue(command),
    effects: cloneValue(applied.effects),
    before: cloneGraphDocument(state.graph),
    after: cloneGraphDocument(applied.graph)
  };
  const nextState: GraphHistoryState = {
    graph: cloneGraphDocument(applied.graph),
    revision,
    limit: state.limit,
    undoStack: trimStack([...cloneStack(state.undoStack), transaction], state.limit),
    redoStack: []
  };
  return { ok: true, action: "commit", state: nextState, transaction };
}

export function undoGraphTransaction(
  state: GraphHistoryState,
  options: GraphHistoryOperationOptions = {}
): GraphHistoryResult {
  const stateErrors = validateState(state, defaultTypeRegistry);
  if (stateErrors.length) return reject(state, "undo", stateErrors);
  const stale = expectedRevisionError(state, options.expectedRevision);
  if (stale.length) return reject(state, "undo", stale);
  const overflow = assertRevisionCanAdvance(state);
  if (overflow.length) return reject(state, "undo", overflow);
  const transaction = state.undoStack.at(-1);
  if (!transaction) {
    return reject(state, "undo", [
      {
        code: "history-empty",
        path: "undoStack",
        message: "there is no transaction to undo"
      }
    ]);
  }

  const nextState: GraphHistoryState = {
    graph: cloneGraphDocument(transaction.before),
    revision: state.revision + 1,
    limit: state.limit,
    undoStack: cloneStack(state.undoStack.slice(0, -1)),
    redoStack: trimStack(
      [...cloneStack(state.redoStack), cloneTransaction(transaction)],
      state.limit
    )
  };
  return {
    ok: true,
    action: "undo",
    state: nextState,
    transaction: cloneTransaction(transaction)
  };
}

export function redoGraphTransaction(
  state: GraphHistoryState,
  options: GraphHistoryOperationOptions = {}
): GraphHistoryResult {
  const stateErrors = validateState(state, defaultTypeRegistry);
  if (stateErrors.length) return reject(state, "redo", stateErrors);
  const stale = expectedRevisionError(state, options.expectedRevision);
  if (stale.length) return reject(state, "redo", stale);
  const overflow = assertRevisionCanAdvance(state);
  if (overflow.length) return reject(state, "redo", overflow);
  const transaction = state.redoStack.at(-1);
  if (!transaction) {
    return reject(state, "redo", [
      {
        code: "history-empty",
        path: "redoStack",
        message: "there is no transaction to redo"
      }
    ]);
  }

  const nextState: GraphHistoryState = {
    graph: cloneGraphDocument(transaction.after),
    revision: state.revision + 1,
    limit: state.limit,
    undoStack: trimStack(
      [...cloneStack(state.undoStack), cloneTransaction(transaction)],
      state.limit
    ),
    redoStack: cloneStack(state.redoStack.slice(0, -1))
  };
  return {
    ok: true,
    action: "redo",
    state: nextState,
    transaction: cloneTransaction(transaction)
  };
}
