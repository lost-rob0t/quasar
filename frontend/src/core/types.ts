export type DocumentId = string;
export type DatasetId = string;

export interface QuasarDocument {
  _id: DocumentId;
  dataset: DatasetId;
  dtype: string;
  version: number;
  date_added: string;
  date_updated: string;
  sources: unknown[];
  data: Record<string, unknown>;
  schema_version?: string;
  title?: string;
  related_ids?: DocumentId[];
  [field: string]: unknown;
}

export interface GraphPosition {
  x: number;
  y: number;
}

export interface GraphViewport {
  zoom: number;
  pan: GraphPosition;
}

export interface SavedGraph {
  id: string;
  name: string;
  documentIds: DocumentId[] | null;
  positions: Record<DocumentId, GraphPosition>;
  viewport: GraphViewport | null;
  layout: string;
  selectedIds: DocumentId[];
}

export interface WorkspaceState {
  graphs: SavedGraph[];
  activeGraphId: string;
  positions: Record<DocumentId, GraphPosition>;
  viewport: GraphViewport | null;
  layout: string;
  selectedIds: DocumentId[];
}

export type GraphOperation =
  | { type: "save"; document: QuasarDocument }
  | { type: "remove"; id: DocumentId }
  | { type: "batch"; operations: GraphOperation[]; label?: string };
