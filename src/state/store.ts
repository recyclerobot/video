// Central editor store. Holds the Project (undoable) and UI state (not
// undoable). All structural edits flow through `update()` or a transaction so
// undo/redo is uniform. Subscribers re-render on change.
import type { Clip, Project } from "../types";

export interface Clipboard {
  clips: Clip[];
  /** Earliest start among copied clips, used to paste relative to the playhead. */
  anchor: number;
}

export interface UIState {
  selectedClipIds: string[];
  selectedTransitionId: string | null;
  zoomPps: number; // pixels per second
  snapping: boolean;
  clipboard: Clipboard | null;
  /** Property currently being keyframe-edited in the inspector (for the lane UI). */
  activeKeyframeProp: string | null;
  status: string;
  /** Bumped on undo/redo/open so panels know to fully refresh. */
  revision: number;
}

function clone<T>(v: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : (JSON.parse(JSON.stringify(v)) as T);
}

export class EditorStore {
  private project: Project;
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private listeners = new Set<() => void>();
  private maxHistory = 100;

  // transaction state
  private txnSnapshot: Project | null = null;
  private txnActive = false;

  ui: UIState = {
    selectedClipIds: [],
    selectedTransitionId: null,
    zoomPps: 80,
    snapping: true,
    clipboard: null,
    activeKeyframeProp: null,
    status: "",
    revision: 0,
  };

  constructor(project: Project) {
    this.project = project;
  }

  // ---- access ----
  getProject(): Project {
    return this.project;
  }

  /** Replace the whole project (new/open). Clears history. */
  setProject(p: Project): void {
    this.project = p;
    this.undoStack = [];
    this.redoStack = [];
    this.txnSnapshot = null;
    this.txnActive = false;
    this.ui.selectedClipIds = [];
    this.ui.selectedTransitionId = null;
    this.ui.revision++;
    this.emit();
  }

  // ---- subscriptions ----
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---- discrete undoable edit ----
  update(_label: string, mutator: (p: Project) => void): void {
    if (this.txnActive) {
      // Inside a transaction: mutate live, the snapshot is already captured.
      mutator(this.project);
      this.emit();
      return;
    }
    this.pushUndo();
    mutator(this.project);
    this.emit();
  }

  private pushUndo(): void {
    this.undoStack.push(clone(this.project));
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  // ---- transactions (coalesce drags into a single undo step) ----
  beginTransaction(_label: string): void {
    if (this.txnActive) return;
    this.txnActive = true;
    this.txnSnapshot = clone(this.project);
  }
  /** Mutate live during a transaction without recording history. */
  mutateLive(mutator: (p: Project) => void): void {
    mutator(this.project);
    this.emit();
  }
  commitTransaction(): void {
    if (!this.txnActive) return;
    this.txnActive = false;
    if (this.txnSnapshot) {
      this.undoStack.push(this.txnSnapshot);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.redoStack = [];
    }
    this.txnSnapshot = null;
    this.emit();
  }
  cancelTransaction(): void {
    if (!this.txnActive) return;
    this.txnActive = false;
    if (this.txnSnapshot) this.project = this.txnSnapshot;
    this.txnSnapshot = null;
    this.emit();
  }

  // ---- undo / redo ----
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(clone(this.project));
    this.project = prev;
    this.pruneSelection();
    this.ui.revision++;
    this.emit();
  }
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.project));
    this.project = next;
    this.pruneSelection();
    this.ui.revision++;
    this.emit();
  }

  // ---- selection ----
  setSelection(ids: string[]): void {
    this.ui.selectedClipIds = ids;
    this.ui.selectedTransitionId = null;
    this.emit();
  }
  toggleSelection(id: string): void {
    const i = this.ui.selectedClipIds.indexOf(id);
    if (i >= 0) this.ui.selectedClipIds.splice(i, 1);
    else this.ui.selectedClipIds.push(id);
    this.ui.selectedTransitionId = null;
    this.emit();
  }
  selectTransition(id: string | null): void {
    this.ui.selectedTransitionId = id;
    this.ui.selectedClipIds = [];
    this.emit();
  }
  isSelected(id: string): boolean {
    return this.ui.selectedClipIds.includes(id);
  }
  primarySelection(): Clip | null {
    const id = this.ui.selectedClipIds[0];
    if (!id) return null;
    return this.project.clips.find((c) => c.id === id) ?? null;
  }
  selectedClips(): Clip[] {
    return this.project.clips.filter((c) =>
      this.ui.selectedClipIds.includes(c.id),
    );
  }
  private pruneSelection(): void {
    const ids = new Set(this.project.clips.map((c) => c.id));
    this.ui.selectedClipIds = this.ui.selectedClipIds.filter((i) => ids.has(i));
  }

  setStatus(msg: string): void {
    this.ui.status = msg;
    this.emit();
  }
}
