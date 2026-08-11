import type { GraphPosition, GraphViewport } from "./types";
import {
  cloneGraphDocument,
  validateGraphDocument,
  type CanonicalGraphDocument,
  type CanonicalGraphEdge,
  type CanonicalGraphNode,
  type GraphValidationIssue,
  type GraphViewState
} from "./graph-document";
import { isStableIdentifier } from "./identifiers";
import { defaultTypeRegistry, type TypeRegistry } from "./type-registry";

export interface GraphCommandBase {
  commandId?: string;
  timestamp?: string;
}

export interface AddNodeCommand extends GraphCommandBase {
  type: "add-node";
  node: CanonicalGraphNode;
}

export interface UpdateNodeCommand extends GraphCommandBase {
  type: "update-node";
  id: string;
  patch: Partial<Omit<CanonicalGraphNode, "id" | "createdAt">>;
}

export interface RemoveNodeCommand extends GraphCommandBase {
  type: "remove-node";
  id: string;
}

export interface AddEdgeCommand extends GraphCommandBase {
  type: "add-edge";
  edge: CanonicalGraphEdge;
}

export interface UpdateEdgeCommand extends GraphCommandBase {
  type: "update-edge";
  id: string;
  patch: Partial<Omit<CanonicalGraphEdge, "id" | "createdAt">>;
}

export interface RemoveEdgeCommand extends GraphCommandBase {
  type: "remove-edge";
  id: string;
}

export interface MoveNodesCommand extends GraphCommandBase {
  type: "move-nodes";
  positions: Record<string, GraphPosition>;
}

export interface SetViewportCommand extends GraphCommandBase {
  type: "set-viewport";
  viewport: GraphViewport | null;
}

export interface SetViewCommand extends GraphCommandBase {
  type: "set-view";
  patch: Partial<GraphViewState>;
}

export interface GraphBatchCommand extends GraphCommandBase {
  type: "batch";
  label?: string;
  commands: GraphCommand[];
}

export type GraphCommand =
  | AddNodeCommand
  | UpdateNodeCommand
  | RemoveNodeCommand
  | AddEdgeCommand
  | UpdateEdgeCommand
  | RemoveEdgeCommand
  | MoveNodesCommand
  | SetViewportCommand
  | SetViewCommand
  | GraphBatchCommand;

export type GraphCommandRejectionCode =
  | "already-exists"
  | "batch-failed"
  | "invalid-command"
  | "not-found"
  | "source-invalid"
  | "validation-failed";

export interface GraphCommandIssue {
  code: GraphCommandRejectionCode;
  path: string;
  message: string;
  commandIndex?: number;
  validation?: GraphValidationIssue[];
}

export interface GraphCommandEffects {
  addedNodeIds: string[];
  updatedNodeIds: string[];
  removedNodeIds: string[];
  addedEdgeIds: string[];
  updatedEdgeIds: string[];
  removedEdgeIds: string[];
  movedNodeIds: string[];
  viewChanged: boolean;
}

export interface GraphCommandSuccess {
  ok: true;
  graph: CanonicalGraphDocument;
  command: GraphCommand;
  effects: GraphCommandEffects;
}

export interface GraphCommandRejection {
  ok: false;
  graph: CanonicalGraphDocument;
  command: GraphCommand;
  errors: GraphCommandIssue[];
}

export type GraphCommandResult = GraphCommandSuccess | GraphCommandRejection;

interface ApplyContext {
  registry: TypeRegistry;
  validateSource: boolean;
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

function emptyEffects(): GraphCommandEffects {
  return {
    addedNodeIds: [],
    updatedNodeIds: [],
    removedNodeIds: [],
    addedEdgeIds: [],
    updatedEdgeIds: [],
    removedEdgeIds: [],
    movedNodeIds: [],
    viewChanged: false
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function mergeEffects(left: GraphCommandEffects, right: GraphCommandEffects): GraphCommandEffects {
  return {
    addedNodeIds: unique([...left.addedNodeIds, ...right.addedNodeIds]),
    updatedNodeIds: unique([...left.updatedNodeIds, ...right.updatedNodeIds]),
    removedNodeIds: unique([...left.removedNodeIds, ...right.removedNodeIds]),
    addedEdgeIds: unique([...left.addedEdgeIds, ...right.addedEdgeIds]),
    updatedEdgeIds: unique([...left.updatedEdgeIds, ...right.updatedEdgeIds]),
    removedEdgeIds: unique([...left.removedEdgeIds, ...right.removedEdgeIds]),
    movedNodeIds: unique([...left.movedNodeIds, ...right.movedNodeIds]),
    viewChanged: left.viewChanged || right.viewChanged
  };
}

function commandTimestamp(command: GraphCommand): string {
  return command.timestamp ?? new Date().toISOString();
}

function issue(
  code: GraphCommandRejectionCode,
  path: string,
  message: string,
  extra: Partial<GraphCommandIssue> = {}
): GraphCommandIssue {
  return { code, path, message, ...extra };
}

function reject(
  source: CanonicalGraphDocument,
  command: GraphCommand,
  errors: GraphCommandIssue[]
): GraphCommandRejection {
  return { ok: false, graph: source, command, errors };
}

function validateIdentifier(
  source: CanonicalGraphDocument,
  command: GraphCommand,
  value: unknown,
  path: string
): GraphCommandRejection | null {
  if (isStableIdentifier(value)) return null;
  return reject(source, command, [issue("invalid-command", path, "must be a stable identifier")]);
}

function validateResult(
  source: CanonicalGraphDocument,
  command: GraphCommand,
  graph: CanonicalGraphDocument,
  effects: GraphCommandEffects,
  registry: TypeRegistry
): GraphCommandResult {
  const validation = validateGraphDocument(graph, registry);
  if (!validation.valid) {
    return reject(source, command, [
      issue("validation-failed", "$", "command produced an invalid graph", {
        validation: validation.errors
      })
    ]);
  }
  return { ok: true, graph, command, effects };
}

function touchGraph(graph: CanonicalGraphDocument, at: string): void {
  graph.metadata.updatedAt = at;
}

function nodeIndex(graph: CanonicalGraphDocument, id: string): number {
  return graph.nodes.findIndex((node) => node.id === id);
}

function edgeIndex(graph: CanonicalGraphDocument, id: string): number {
  return graph.edges.findIndex((edge) => edge.id === id);
}

function idExists(graph: CanonicalGraphDocument, id: string): boolean {
  return nodeIndex(graph, id) >= 0 || edgeIndex(graph, id) >= 0;
}

function applyAddNode(
  source: CanonicalGraphDocument,
  command: AddNodeCommand,
  context: ApplyContext
): GraphCommandResult {
  const invalid = validateIdentifier(source, command, command.node?.id, "node.id");
  if (invalid) return invalid;
  if (idExists(source, command.node.id)) {
    return reject(source, command, [
      issue("already-exists", "node.id", `graph already contains ${command.node.id}`)
    ]);
  }

  const graph = cloneGraphDocument(source);
  graph.nodes.push(cloneValue(command.node));
  touchGraph(graph, commandTimestamp(command));
  const effects = emptyEffects();
  effects.addedNodeIds.push(command.node.id);
  return validateResult(source, command, graph, effects, context.registry);
}

function applyUpdateNode(
  source: CanonicalGraphDocument,
  command: UpdateNodeCommand,
  context: ApplyContext
): GraphCommandResult {
  const invalid = validateIdentifier(source, command, command.id, "id");
  if (invalid) return invalid;
  const index = nodeIndex(source, command.id);
  if (index < 0) {
    return reject(source, command, [issue("not-found", "id", `node ${command.id} does not exist`)]);
  }
  if (!isRecord(command.patch)) {
    return reject(source, command, [issue("invalid-command", "patch", "must be an object")]);
  }

  const at = commandTimestamp(command);
  const graph = cloneGraphDocument(source);
  const current = graph.nodes[index];
  graph.nodes[index] = {
    ...current,
    ...cloneValue(command.patch),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: at,
    properties:
      command.patch.properties === undefined
        ? current.properties
        : cloneValue(command.patch.properties as Record<string, unknown>),
    extensions:
      command.patch.extensions === undefined
        ? current.extensions
        : cloneValue(command.patch.extensions as Record<string, unknown>)
  };
  touchGraph(graph, at);
  const effects = emptyEffects();
  effects.updatedNodeIds.push(command.id);
  return validateResult(source, command, graph, effects, context.registry);
}

function applyRemoveNode(
  source: CanonicalGraphDocument,
  command: RemoveNodeCommand,
  context: ApplyContext
): GraphCommandResult {
  const invalid = validateIdentifier(source, command, command.id, "id");
  if (invalid) return invalid;
  if (nodeIndex(source, command.id) < 0) {
    return reject(source, command, [issue("not-found", "id", `node ${command.id} does not exist`)]);
  }

  const graph = cloneGraphDocument(source);
  const attachedEdgeIds = graph.edges
    .filter((edge) => edge.source === command.id || edge.target === command.id)
    .map((edge) => edge.id)
    .sort((left, right) => left.localeCompare(right));
  const attached = new Set(attachedEdgeIds);
  graph.nodes = graph.nodes.filter((node) => node.id !== command.id);
  graph.edges = graph.edges.filter((edge) => !attached.has(edge.id));
  graph.view.selectedIds = graph.view.selectedIds.filter((id) => id !== command.id);
  touchGraph(graph, commandTimestamp(command));

  const effects = emptyEffects();
  effects.removedNodeIds.push(command.id);
  effects.removedEdgeIds.push(...attachedEdgeIds);
  if (source.view.selectedIds.includes(command.id)) effects.viewChanged = true;
  return validateResult(source, command, graph, effects, context.registry);
}

function applyAddEdge(
  source: CanonicalGraphDocument,
  command: AddEdgeCommand,
  context: ApplyContext
): GraphCommandResult {
  const invalid = validateIdentifier(source, command, command.edge?.id, "edge.id");
  if (invalid) return invalid;
  if (idExists(source, command.edge.id)) {
    return reject(source, command, [
      issue("already-exists", "edge.id", `graph already contains ${command.edge.id}`)
    ]);
  }

  const graph = cloneGraphDocument(source);
  graph.edges.push(cloneValue(command.edge));
  touchGraph(graph, commandTimestamp(command));
  const effects = emptyEffects();
  effects.addedEdgeIds.push(command.edge.id);
  return validateResult(source, command, graph, effects, context.registry);
}

function applyUpdateEdge(
  source: CanonicalGraphDocument,
  command: UpdateEdgeCommand,
  context: ApplyContext
): GraphCommandResult {
  const invalid = validateIdentifier(source, command, command.id, "id");
  if (invalid) return invalid;
  const index = edgeIndex(source, command.id);
  if (index < 0) {
    return reject(source, command, [issue("not-found", "id", `edge ${command.id} does not exist`)]);
  }
  if (!isRecord(command.patch)) {
    return reject(source, command, [issue("invalid-command", "patch", "must be an object")]);
  }

  const at = commandTimestamp(command);
  const graph = cloneGraphDocument(source);
  const current = graph.edges[index];
  graph.edges[index] = {
    ...current,
    ...cloneValue(command.patch),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: at,
    properties:
      command.patch.properties === undefined
        ? current.properties
        : cloneValue(command.patch.properties as Record<string, unknown>),
    extensions:
      command.patch.extensions === undefined
        ? current.extensions
        : cloneValue(command.patch.extensions as Record<string, unknown>)
  };
  touchGraph(graph, at);
  const effects = emptyEffects();
  effects.updatedEdgeIds.push(command.id);
  return validateResult(source, command, graph, effects, context.registry);
}

function applyRemoveEdge(
  source: CanonicalGraphDocument,
  command: RemoveEdgeCommand,
  context: ApplyContext
): GraphCommandResult {
  const invalid = validateIdentifier(source, command, command.id, "id");
  if (invalid) return invalid;
  if (edgeIndex(source, command.id) < 0) {
    return reject(source, command, [issue("not-found", "id", `edge ${command.id} does not exist`)]);
  }

  const graph = cloneGraphDocument(source);
  graph.edges = graph.edges.filter((edge) => edge.id !== command.id);
  touchGraph(graph, commandTimestamp(command));
  const effects = emptyEffects();
  effects.removedEdgeIds.push(command.id);
  return validateResult(source, command, graph, effects, context.registry);
}

function validPosition(value: unknown): value is GraphPosition {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function applyMoveNodes(
  source: CanonicalGraphDocument,
  command: MoveNodesCommand,
  context: ApplyContext
): GraphCommandResult {
  if (!isRecord(command.positions) || !Object.keys(command.positions).length) {
    return reject(source, command, [
      issue("invalid-command", "positions", "must contain at least one node position")
    ]);
  }

  const errors: GraphCommandIssue[] = [];
  for (const [id, position] of Object.entries(command.positions)) {
    if (!isStableIdentifier(id)) {
      errors.push(issue("invalid-command", `positions.${id}`, "node id must be stable"));
    } else if (nodeIndex(source, id) < 0) {
      errors.push(issue("not-found", `positions.${id}`, `node ${id} does not exist`));
    } else if (!validPosition(position)) {
      errors.push(
        issue("invalid-command", `positions.${id}`, "must contain finite x and y numbers")
      );
    }
  }
  if (errors.length) return reject(source, command, errors);

  const at = commandTimestamp(command);
  const graph = cloneGraphDocument(source);
  const movedIds = Object.keys(command.positions);
  const positions = new Map(Object.entries(command.positions));
  graph.nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, position: cloneValue(position), updatedAt: at } : node;
  });
  touchGraph(graph, at);
  const effects = emptyEffects();
  effects.movedNodeIds.push(...movedIds);
  effects.updatedNodeIds.push(...movedIds);
  return validateResult(source, command, graph, effects, context.registry);
}

function applySetViewport(
  source: CanonicalGraphDocument,
  command: SetViewportCommand,
  context: ApplyContext
): GraphCommandResult {
  const graph = cloneGraphDocument(source);
  graph.view.viewport = command.viewport === null ? null : cloneValue(command.viewport);
  touchGraph(graph, commandTimestamp(command));
  const effects = emptyEffects();
  effects.viewChanged = true;
  return validateResult(source, command, graph, effects, context.registry);
}

function applySetView(
  source: CanonicalGraphDocument,
  command: SetViewCommand,
  context: ApplyContext
): GraphCommandResult {
  if (!isRecord(command.patch)) {
    return reject(source, command, [issue("invalid-command", "patch", "must be an object")]);
  }

  const graph = cloneGraphDocument(source);
  graph.view = {
    ...graph.view,
    ...cloneValue(command.patch),
    extensions:
      command.patch.extensions === undefined
        ? graph.view.extensions
        : cloneValue(command.patch.extensions as Record<string, unknown>),
    selectedIds:
      command.patch.selectedIds === undefined
        ? graph.view.selectedIds
        : [...command.patch.selectedIds],
    viewport:
      command.patch.viewport === undefined
        ? graph.view.viewport
        : command.patch.viewport === null
          ? null
          : cloneValue(command.patch.viewport)
  };
  touchGraph(graph, commandTimestamp(command));
  const effects = emptyEffects();
  effects.viewChanged = true;
  return validateResult(source, command, graph, effects, context.registry);
}

function applyBatch(
  source: CanonicalGraphDocument,
  command: GraphBatchCommand,
  context: ApplyContext
): GraphCommandResult {
  if (!Array.isArray(command.commands)) {
    return reject(source, command, [issue("invalid-command", "commands", "must be an array")]);
  }

  let working = source;
  let effects = emptyEffects();
  for (let index = 0; index < command.commands.length; index += 1) {
    const child = command.commands[index];
    const result = applyInternal(working, child, {
      ...context,
      validateSource: false
    });
    if (!result.ok) {
      return reject(source, command, [
        issue("batch-failed", `commands[${index}]`, `batch command ${index} failed`, {
          commandIndex: index
        }),
        ...result.errors.map((error) => ({
          ...error,
          path: `commands[${index}].${error.path}`,
          commandIndex: index
        }))
      ]);
    }
    working = result.graph;
    effects = mergeEffects(effects, result.effects);
  }

  if (command.timestamp) touchGraph(working, command.timestamp);
  return { ok: true, graph: working, command, effects };
}

function unknownCommand(
  source: CanonicalGraphDocument,
  command: GraphCommand
): GraphCommandRejection {
  const type = isRecord(command) ? String(command.type) : String(command);
  return reject(source, command, [
    issue("invalid-command", "type", `unknown graph command type ${type}`)
  ]);
}

function applyInternal(
  source: CanonicalGraphDocument,
  command: GraphCommand,
  context: ApplyContext
): GraphCommandResult {
  if (!isRecord(command) || typeof command.type !== "string") {
    return reject(source, command, [
      issue("invalid-command", "$", "command must be an object with a type")
    ]);
  }

  if (context.validateSource) {
    const sourceValidation = validateGraphDocument(source, context.registry);
    if (!sourceValidation.valid) {
      return reject(source, command, [
        issue("source-invalid", "$", "source graph is invalid", {
          validation: sourceValidation.errors
        })
      ]);
    }
  }

  switch (command.type) {
    case "add-node":
      return applyAddNode(source, command, context);
    case "update-node":
      return applyUpdateNode(source, command, context);
    case "remove-node":
      return applyRemoveNode(source, command, context);
    case "add-edge":
      return applyAddEdge(source, command, context);
    case "update-edge":
      return applyUpdateEdge(source, command, context);
    case "remove-edge":
      return applyRemoveEdge(source, command, context);
    case "move-nodes":
      return applyMoveNodes(source, command, context);
    case "set-viewport":
      return applySetViewport(source, command, context);
    case "set-view":
      return applySetView(source, command, context);
    case "batch":
      return applyBatch(source, command, context);
    default:
      return unknownCommand(source, command);
  }
}

export function applyGraphCommand(
  source: CanonicalGraphDocument,
  command: GraphCommand,
  registry: TypeRegistry = defaultTypeRegistry
): GraphCommandResult {
  return applyInternal(source, command, { registry, validateSource: true });
}

export function applyGraphBatch(
  source: CanonicalGraphDocument,
  commands: GraphCommand[],
  options: {
    label?: string;
    commandId?: string;
    timestamp?: string;
    registry?: TypeRegistry;
  } = {}
): GraphCommandResult {
  return applyGraphCommand(
    source,
    {
      type: "batch",
      commands,
      ...(options.label ? { label: options.label } : {}),
      ...(options.commandId ? { commandId: options.commandId } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {})
    },
    options.registry ?? defaultTypeRegistry
  );
}
