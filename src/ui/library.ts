// Media library: imported assets (video/audio/image/sequence) + LUTs.
import type { EditorStore } from "../state/store";
import { fmtTime, escapeHtml } from "../util";

export interface LibraryHooks {
  onImportFiles(files: File[]): Promise<void>;
  onAddMedia(mediaId: string): void;
  onImportLut(file: File): Promise<void>;
  onDeleteMedia(mediaId: string): void;
}

export class Library {
  private list: HTMLElement;
  private lutList: HTMLElement;

  constructor(
    root: HTMLElement,
    private store: EditorStore,
    private hooks: LibraryHooks,
  ) {
    this.list = root.querySelector("#mediaList")!;
    this.lutList = root.querySelector("#lutList")!;
    const fileInput = root.querySelector<HTMLInputElement>("#fileInput")!;
    fileInput.addEventListener("change", async () => {
      if (fileInput.files) await this.hooks.onImportFiles(Array.from(fileInput.files));
      fileInput.value = "";
    });
    const lutInput = root.querySelector<HTMLInputElement>("#lutInput")!;
    lutInput.addEventListener("change", async () => {
      if (lutInput.files) for (const f of Array.from(lutInput.files)) await this.hooks.onImportLut(f);
      lutInput.value = "";
    });
    this.store.subscribe(() => this.render());
  }

  render(): void {
    const p = this.store.getProject();
    this.list.textContent = "";
    for (const m of p.media) {
      const div = document.createElement("div");
      div.className = "lib-item";
      div.draggable = true;
      const dur = m.type === "sequence" ? `${m.frameBlobIds?.length ?? 0} frames` : m.type === "image" ? "still" : fmtTime(m.duration);
      div.innerHTML = `
        <div class="thumb" style="${m.thumbnail ? `background-image:url(${m.thumbnail});` : "background:#222;"}"></div>
        <div style="min-width:0;flex:1;">
          <div class="name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
          <div class="dur">${m.type} · ${dur}</div>
        </div>
        <div class="lib-actions">
          <button data-add="${m.id}" title="Add to timeline">＋</button>
          <button data-del="${m.id}" class="danger" title="Remove from library">×</button>
        </div>`;
      div.addEventListener("dragstart", (ev) => ev.dataTransfer?.setData("application/x-media-id", m.id));
      div.addEventListener("dblclick", () => this.hooks.onAddMedia(m.id));
      // Explicit button, because dragging onto the timeline is mouse-only.
      div.querySelector<HTMLButtonElement>("[data-add]")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.onAddMedia(m.id);
      });
      div.querySelector<HTMLButtonElement>("[data-del]")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.onDeleteMedia(m.id);
      });
      this.list.append(div);
    }

    this.lutList.textContent = "";
    for (const l of p.luts) {
      const row = document.createElement("div");
      row.className = "lut-item";
      row.innerHTML = `<span>${escapeHtml(l.name)} (${l.size}³)</span>`;
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "×";
      del.addEventListener("click", () => {
        this.store.update("Remove LUT", (pr) => {
          pr.luts = pr.luts.filter((x) => x.id !== l.id);
        });
      });
      row.append(del);
      this.lutList.append(row);
    }
  }
}
