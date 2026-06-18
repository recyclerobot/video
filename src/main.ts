import "./style.css";
import {
  defaultProject,
  defaultTransform,
  defaultAudioProps,
  makeColorGradeFilter,
  newId,
  type Clip,
  type EffectClip,
  type ImageClip,
  type MediaAsset,
  type SequenceClip,
  type TitleClip,
  type VideoClip,
  type AudioClip,
  type VisualClip,
} from "./types";
import { EditorStore } from "./state/store";
import {
  copySelection,
  cutSelection,
  duplicateSelection,
  nudgeSelection,
  pasteClipboard,
  removeClips,
  splitAtPlayhead,
} from "./state/commands";
import { isAnimated, addKeyframe, sampleAt } from "./engine/keyframes";
import { PlaybackEngine } from "./engine/playback";
import { exportMp4, parseCube } from "./export";
import { exportProjectBundle, importProjectBundle } from "./projectFile";
import {
  putBlob,
  deleteBlob,
  saveProject,
  loadProject,
  listProjects,
  deleteProject,
} from "./storage";
import { probeMedia, probeImage } from "./media/media";
import { detectSequences } from "./media/sequence";
import { computePeaks } from "./media/waveform";
import { Timeline } from "./ui/timeline";
import { Inspector } from "./ui/inspector";
import { Library } from "./ui/library";
import { fmtTime, fmtTimecode, clamp } from "./util";

// ---------------------------------------------------------------------------
// DOM scaffold
// ---------------------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <h1>RR Video</h1>
    <span class="status" id="status"></span>
    <div class="spacer"></div>
    <button id="undoBtn" title="Undo (⌘Z)">↶</button>
    <button id="redoBtn" title="Redo (⌘⇧Z)">↷</button>
    <button id="addTitleBtn">+ Title</button>
    <button id="addEffectBtn">+ Adjust</button>
    <button id="addVideoTrackBtn">+ V</button>
    <button id="addAudioTrackBtn">+ A</button>
    <button id="projectsBtn">Projects</button>
    <button id="saveProjectBtn">Save</button>
    <button id="newProjectBtn" class="danger">New</button>
    <button id="exportBtn" class="primary">Export</button>
  </header>
  <aside class="panel library">
    <h2>Media</h2>
    <div class="body">
      <input type="file" id="fileInput" accept="video/*,audio/*,image/*" multiple />
      <div id="mediaList" class="media-list"></div>
      <div class="section-title">Color LUTs (.cube)</div>
      <input type="file" id="lutInput" accept=".cube" />
      <div id="lutList" class="lut-list"></div>
      <div class="section-title">Project file</div>
      <div class="row" style="gap:6px;">
        <button id="exportProjBtn" style="flex:1;">Export .rrvproj</button>
        <label class="btn" style="flex:1;text-align:center;cursor:pointer;">Import<input type="file" id="importProjInput" accept=".rrvproj,application/json" hidden /></label>
      </div>
    </div>
  </aside>
  <section class="preview">
    <div class="canvas-wrap" id="canvasWrap">
      <canvas id="previewCanvas"></canvas>
    </div>
    <div class="transport">
      <button id="playBtn">▶</button>
      <button id="stopBtn">■</button>
      <span class="time" id="timeDisplay">00:00.00 / 00:00.00</span>
      <input type="range" id="seek" min="0" max="100" step="0.01" value="0" style="flex:1" />
      <label class="muted-note">Zoom</label>
      <input type="range" id="zoom" min="20" max="400" value="80" step="1" style="width:120px" />
    </div>
  </section>
  <aside class="panel inspector">
    <h2>Inspector</h2>
    <div class="body" id="inspectorBody"></div>
  </aside>
  <section class="timeline" id="timelineSection">
    <div class="toolbar">
      <button id="splitBtn" title="Split at playhead (S)">Split</button>
      <button id="deleteBtn" class="danger" title="Delete (⌫)">Delete</button>
      <button id="rippleBtn" class="danger" title="Ripple delete (⇧⌫)">Ripple ⌫</button>
      <button id="dupBtn" title="Duplicate (⌘D)">Duplicate</button>
      <button id="markerBtn" title="Add marker (M)">＋ Marker</button>
      <label class="snap-label"><input type="checkbox" id="snapToggle" checked /> Snap</label>
      <span class="status" id="tlStatus"></span>
    </div>
    <div class="ruler" id="ruler"></div>
    <div class="tracks-scroll" id="tracksScroll"><div id="tracksContainer"></div></div>
  </section>
`;

// ---------------------------------------------------------------------------
// Core wiring
// ---------------------------------------------------------------------------
const canvas = document.getElementById("previewCanvas") as HTMLCanvasElement;
const store = new EditorStore(defaultProject());
const engine = new PlaybackEngine(store.getProject(), canvas);

const timeline = new Timeline(document.getElementById("timelineSection")!, store, engine, {
  onDropMedia: (mediaId, trackId, start) => addMediaToTimeline(mediaId, trackId, start),
});
new Inspector(document.querySelector(".inspector")!, store, engine);
new Library(document.querySelector(".library")!, store, {
  onImportFiles: importFiles,
  onAddMedia: (id) => addMediaToTimeline(id),
  onImportLut: importLut,
  onDeleteMedia: deleteMedia,
});

function setStatus(msg: string): void {
  const el = document.getElementById("status")!;
  el.textContent = msg;
  window.setTimeout(() => {
    if (el.textContent === msg) el.textContent = "";
  }, 1800);
}

// ---------------------------------------------------------------------------
// Persistence + reconciliation
// ---------------------------------------------------------------------------
let saveTimer = 0;
let knownClipIds = new Set<string>();

store.subscribe(() => {
  const p = store.getProject();
  engine.project = p;
  engine.setProject(p);
  reconcileClips();
  engine.renderFrame();
  // autosave (debounced)
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveProject(p, Date.now());
  }, 350);
  updateUndoButtons();
});

function reconcileClips(): void {
  const p = store.getProject();
  const ids = new Set(p.clips.map((c) => c.id));
  for (const c of p.clips) {
    if (!knownClipIds.has(c.id)) void engine.preloadClip(c as VisualClip | { kind: string });
  }
  for (const old of knownClipIds) if (!ids.has(old)) engine.disposeClip(old);
  knownClipIds = ids;
}

function updateUndoButtons(): void {
  (document.getElementById("undoBtn") as HTMLButtonElement).disabled = !store.canUndo();
  (document.getElementById("redoBtn") as HTMLButtonElement).disabled = !store.canRedo();
}

// ---------------------------------------------------------------------------
// Preview canvas sizing
// ---------------------------------------------------------------------------
function sizePreview(): void {
  const wrap = document.getElementById("canvasWrap")!;
  const r = wrap.getBoundingClientRect();
  const p = store.getProject();
  const ar = p.width / p.height;
  let w = r.width - 24;
  let h = r.height - 24;
  if (w / h > ar) w = h * ar;
  else h = w / ar;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}
window.addEventListener("resize", () => {
  sizePreview();
  timeline.render();
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function importFiles(files: File[]): Promise<void> {
  const { sequences, singles } = detectSequences(files);
  for (const seq of sequences) await importSequence(seq.name, seq.files);
  for (const f of singles) await importSingle(f);
  setStatus("import complete");
}

async function importSingle(file: File): Promise<void> {
  setStatus(`importing ${file.name}…`);
  try {
    const probe = await probeMedia(file);
    const asset: MediaAsset = {
      id: newId("m"),
      name: file.name,
      type: probe.type,
      size: file.size,
      duration: probe.duration,
      thumbnail: probe.thumbnail,
      width: probe.width,
      height: probe.height,
    };
    await putBlob(asset.id, file);
    store.update("Import media", (p) => p.media.push(asset));
    if (probe.type === "audio") void computeAndAttachPeaks(asset.id, file);
  } catch (e) {
    console.error(e);
    setStatus(`failed: ${file.name}`);
  }
}

async function importSequence(name: string, files: File[]): Promise<void> {
  setStatus(`importing sequence ${name}…`);
  const frameBlobIds: string[] = [];
  for (const f of files) {
    const id = newId("frm");
    await putBlob(id, f);
    frameBlobIds.push(id);
  }
  const probe = await probeImage(files[0]);
  const fps = 24;
  const asset: MediaAsset = {
    id: newId("m"),
    name,
    type: "sequence",
    size: files.reduce((a, f) => a + f.size, 0),
    duration: files.length / fps,
    thumbnail: probe.thumbnail,
    width: probe.width,
    height: probe.height,
    frameBlobIds,
    fps,
  };
  store.update("Import sequence", (p) => p.media.push(asset));
}

async function computeAndAttachPeaks(mediaId: string, blob: Blob): Promise<void> {
  try {
    const peaks = await computePeaks(blob);
    store.update("Waveform", (p) => {
      const m = p.media.find((x) => x.id === mediaId);
      if (m) m.peaks = peaks;
    });
  } catch {
    /* ignore */
  }
}

async function importLut(file: File): Promise<void> {
  try {
    const { size, data } = parseCube(await file.text());
    store.update("Import LUT", (p) => p.luts.push({ id: newId("lut"), name: file.name, size, data }));
    setStatus(`LUT ${file.name} imported`);
  } catch (e) {
    setStatus(`LUT failed: ${(e as Error).message}`);
  }
}

function deleteMedia(mediaId: string): void {
  const p = store.getProject();
  const m = p.media.find((x) => x.id === mediaId);
  store.update("Delete media", (pr) => {
    pr.media = pr.media.filter((x) => x.id !== mediaId);
    pr.clips = pr.clips.filter((c) => !("mediaId" in c) || (c as VideoClip).mediaId !== mediaId);
  });
  if (m?.type === "sequence") for (const fid of m.frameBlobIds ?? []) void deleteBlob(fid);
  else void deleteBlob(mediaId);
}

// ---------------------------------------------------------------------------
// Add clips to timeline
// ---------------------------------------------------------------------------
function endOfTrack(trackId: string): number {
  let max = 0;
  for (const c of store.getProject().clips)
    if (c.trackId === trackId) max = Math.max(max, c.start + c.duration);
  return max;
}

function addMediaToTimeline(mediaId: string, trackId?: string, start?: number): void {
  const p = store.getProject();
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) return;
  const wantKind = m.type === "audio" ? "audio" : "video";
  const track =
    (trackId ? p.tracks.find((t) => t.id === trackId) : null) ??
    p.tracks.find((t) => t.kind === wantKind);
  if (!track) {
    setStatus("no suitable track");
    return;
  }
  const startT = start ?? endOfTrack(track.id);
  let clip: Clip;
  if (m.type === "video") {
    clip = {
      id: newId("c"), kind: "video", trackId: track.id, mediaId: m.id, start: startT,
      duration: m.duration || 5, inPoint: 0, speed: 1, useOwnAudio: true,
      transform: defaultTransform(), filters: [], audio: defaultAudioProps(),
    } as VideoClip;
  } else if (m.type === "audio") {
    clip = {
      id: newId("c"), kind: "audio", trackId: track.id, mediaId: m.id, start: startT,
      duration: m.duration || 5, inPoint: 0, speed: 1, audio: defaultAudioProps(),
    } as AudioClip;
  } else if (m.type === "image") {
    clip = {
      id: newId("c"), kind: "image", trackId: track.id, mediaId: m.id, start: startT,
      duration: 5, transform: defaultTransform(), filters: [],
    } as ImageClip;
  } else {
    clip = {
      id: newId("c"), kind: "sequence", trackId: track.id, mediaId: m.id, start: startT,
      duration: m.duration || 2, sourceFps: m.fps ?? 24, inFrame: 0, speed: 1, holdLast: true,
      transform: defaultTransform(), filters: [],
    } as SequenceClip;
  }
  store.update("Add clip", (pr) => pr.clips.push(clip));
  store.setSelection([clip.id]);
}

function addTitle(): void {
  const p = store.getProject();
  const tr = p.tracks.find((t) => t.kind === "title");
  if (!tr) return;
  const c: TitleClip = {
    id: newId("c"), kind: "title", trackId: tr.id, start: engine.time, duration: 3,
    text: "Title", fontFamily: "system-ui", fontSize: 72, fontWeight: 700, italic: false,
    color: "#ffffff", align: "center", lineHeight: 1.2, letterSpacing: 0,
    strokeColor: "#000000", strokeWidth: 0,
    shadow: { enabled: true, color: "#000000", blur: 8, x: 0, y: 3 },
    bgColor: "transparent", bgPadding: 16, bgRadius: 8,
    animation: { preset: "fade", inDuration: 0.4, outDuration: 0.4 },
    transform: defaultTransform(), filters: [],
  };
  store.update("Add title", (pr) => pr.clips.push(c));
  store.setSelection([c.id]);
}

function addEffect(): void {
  const p = store.getProject();
  const tr = p.tracks.find((t) => t.kind === "effect");
  if (!tr) return;
  const c: EffectClip = {
    id: newId("c"), kind: "effect", trackId: tr.id, start: engine.time, duration: 3,
    filters: [makeColorGradeFilter()],
  };
  store.update("Add adjustment", (pr) => pr.clips.push(c));
  store.setSelection([c.id]);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;
const seekRange = document.getElementById("seek") as HTMLInputElement;
const zoomRange = document.getElementById("zoom") as HTMLInputElement;
const timeDisplay = document.getElementById("timeDisplay") as HTMLSpanElement;

playBtn.addEventListener("click", () => togglePlay());
async function togglePlay(): Promise<void> {
  if (engine.playing) {
    engine.pause();
    playBtn.textContent = "▶";
  } else {
    await engine.play();
    playBtn.textContent = "❚❚";
  }
}
document.getElementById("stopBtn")!.addEventListener("click", () => {
  engine.pause();
  engine.seek(0);
  playBtn.textContent = "▶";
});
seekRange.addEventListener("input", () => engine.seek((parseFloat(seekRange.value) / 100) * engine.duration()));
zoomRange.addEventListener("input", () => {
  store.ui.zoomPps = parseInt(zoomRange.value, 10);
  timeline.render();
});

engine.onTime = (t) => {
  const dur = engine.duration();
  const p = store.getProject();
  timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur)}  ·  ${fmtTimecode(t, p.fps)}`;
  seekRange.value = String((t / dur) * 100);
  timeline.updatePlayhead();
};
engine.onEnded = () => (playBtn.textContent = "▶");

// ---------------------------------------------------------------------------
// Topbar actions
// ---------------------------------------------------------------------------
document.getElementById("undoBtn")!.addEventListener("click", () => store.undo());
document.getElementById("redoBtn")!.addEventListener("click", () => store.redo());
document.getElementById("addTitleBtn")!.addEventListener("click", addTitle);
document.getElementById("addEffectBtn")!.addEventListener("click", addEffect);
document.getElementById("addVideoTrackBtn")!.addEventListener("click", () =>
  store.update("Add video track", (p) =>
    p.tracks.push({ id: newId("t"), kind: "video", name: `Video ${p.tracks.filter((t) => t.kind === "video").length + 1}` }),
  ),
);
document.getElementById("addAudioTrackBtn")!.addEventListener("click", () =>
  store.update("Add audio track", (p) =>
    p.tracks.push({ id: newId("t"), kind: "audio", name: `Audio ${p.tracks.filter((t) => t.kind === "audio").length + 1}`, gain: 1, pan: 0 }),
  ),
);
document.getElementById("splitBtn")!.addEventListener("click", () => splitAtPlayhead(store, engine.time));
document.getElementById("deleteBtn")!.addEventListener("click", () => removeClips(store, store.ui.selectedClipIds));
document.getElementById("rippleBtn")!.addEventListener("click", () => removeClips(store, store.ui.selectedClipIds, true));
document.getElementById("dupBtn")!.addEventListener("click", () => duplicateSelection(store));
document.getElementById("markerBtn")!.addEventListener("click", addMarker);
document.getElementById("snapToggle")!.addEventListener("change", (e) => {
  store.ui.snapping = (e.target as HTMLInputElement).checked;
});
document.getElementById("saveProjectBtn")!.addEventListener("click", async () => {
  await saveProject(store.getProject(), Date.now());
  setStatus("saved");
});
document.getElementById("newProjectBtn")!.addEventListener("click", () => {
  if (!confirm("Start a new project? (current is saved)")) return;
  void saveProject(store.getProject(), Date.now());
  const fresh = defaultProject();
  store.setProject(fresh);
  knownClipIds = new Set();
  sizePreview();
});
document.getElementById("projectsBtn")!.addEventListener("click", openProjectsDialog);
document.getElementById("exportBtn")!.addEventListener("click", openExportDialog);
document.getElementById("exportProjBtn")!.addEventListener("click", async () => {
  const blob = await exportProjectBundle(store.getProject());
  downloadBlob(blob, `${store.getProject().name}.rrvproj`);
});
document.getElementById("importProjInput")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const project = await importProjectBundle(file);
    store.setProject(project);
    knownClipIds = new Set();
    await engine.preloadAll();
    engine.renderFrame();
    sizePreview();
    setStatus("project imported");
  } catch (err) {
    setStatus(`import failed: ${(err as Error).message}`);
  }
});

function addMarker(): void {
  store.update("Add marker", (p) =>
    p.markers.push({ id: newId("mk"), time: engine.time, label: `M${p.markers.length + 1}`, color: "#f9e2af" }),
  );
}

// ---------------------------------------------------------------------------
// Preview direct manipulation (move selected visual clip)
// ---------------------------------------------------------------------------
canvas.addEventListener("mousedown", (ev) => {
  const c = store.primarySelection();
  if (!c || !["video", "image", "sequence", "title"].includes(c.kind)) return;
  const rect = canvas.getBoundingClientRect();
  const startX = ev.clientX;
  const startY = ev.clientY;
  const vc = c as VisualClip;
  const lt = clamp(engine.time - c.start, 0, c.duration);
  const baseX = sampleAt(vc.transform.x, lt);
  const baseY = sampleAt(vc.transform.y, lt);
  const animatedX = isAnimated(vc.transform.x);
  const animatedY = isAnimated(vc.transform.y);
  store.beginTransaction("Move (preview)");
  const onMove = (e: MouseEvent) => {
    const dx = ((e.clientX - startX) / rect.width) * 2;
    const dy = ((e.clientY - startY) / rect.height) * 2;
    store.mutateLive((p) => {
      const cc = p.clips.find((x) => x.id === c.id) as VisualClip | undefined;
      if (!cc) return;
      cc.transform.x = animatedX ? addKeyframe(cc.transform.x, lt, baseX + dx) : baseX + dx;
      cc.transform.y = animatedY ? addKeyframe(cc.transform.y, lt, baseY + dy) : baseY + dy;
    });
    engine.renderFrame();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    store.commitTransaction();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});
// wheel to scale selected visual clip
canvas.addEventListener("wheel", (ev) => {
  const c = store.primarySelection();
  if (!c || !["video", "image", "sequence", "title"].includes(c.kind)) return;
  ev.preventDefault();
  const vc = c as VisualClip;
  if (isAnimated(vc.transform.scale)) return;
  const cur = vc.transform.scale as number;
  const next = clamp(cur * (ev.deltaY < 0 ? 1.05 : 0.95), 0.05, 6);
  store.update("Scale", (p) => {
    const cc = p.clips.find((x) => x.id === c.id) as VisualClip | undefined;
    if (cc) cc.transform.scale = next;
  });
  engine.renderFrame();
}, { passive: false });

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT") return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === "Space") {
    e.preventDefault();
    void togglePlay();
  } else if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (mod && e.key.toLowerCase() === "c") {
    copySelection(store);
  } else if (mod && e.key.toLowerCase() === "x") {
    cutSelection(store);
  } else if (mod && e.key.toLowerCase() === "v") {
    pasteClipboard(store, engine.time);
  } else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelection(store);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeClips(store, store.ui.selectedClipIds, e.shiftKey);
  } else if (e.key.toLowerCase() === "s") {
    splitAtPlayhead(store, engine.time);
  } else if (e.key.toLowerCase() === "m") {
    addMarker();
  } else if (e.key === "ArrowLeft") {
    const dt = 1 / store.getProject().fps;
    if (store.ui.selectedClipIds.length) nudgeSelection(store, -(e.shiftKey ? dt * 10 : dt));
    else engine.seek(engine.time - (e.shiftKey ? dt * 10 : dt));
  } else if (e.key === "ArrowRight") {
    const dt = 1 / store.getProject().fps;
    if (store.ui.selectedClipIds.length) nudgeSelection(store, e.shiftKey ? dt * 10 : dt);
    else engine.seek(engine.time + (e.shiftKey ? dt * 10 : dt));
  }
});

// ---------------------------------------------------------------------------
// Export dialog
// ---------------------------------------------------------------------------
function openExportDialog(): void {
  if (engine.playing) togglePlay();
  const p = store.getProject();
  const dur = engine.duration();
  const modal = makeModal("Export MP4");
  modal.body.innerHTML = `
    <div class="row"><label>Resolution</label>
      <select id="exRes">
        <option value="1">Project (${p.width}×${p.height})</option>
        <option value="0.5">Half</option>
        <option value="2">2×</option>
        <option value="1280x720">720p</option>
        <option value="1920x1080">1080p</option>
        <option value="3840x2160">4K</option>
      </select></div>
    <div class="row"><label>FPS</label><input type="number" id="exFps" value="${p.fps}" min="1" max="60"/></div>
    <div class="row"><label>Bitrate Mbps</label><input type="number" id="exBr" value="8" min="1" max="80"/></div>
    <div class="row"><label><input type="checkbox" id="exRange"/> Range only</label>
      <input type="number" id="exIn" value="0" step="0.1" style="width:60px"/>
      <input type="number" id="exOut" value="${dur.toFixed(1)}" step="0.1" style="width:60px"/></div>
    <div class="row" style="justify-content:flex-end;gap:6px;margin-top:8px;">
      <button id="exFrameBtn">Save frame PNG</button>
      <button id="exGoBtn" class="primary">Export</button>
    </div>
    <div id="exProgress" class="muted-note" style="margin-top:8px;"></div>
  `;
  const q = <T extends HTMLElement>(s: string) => modal.body.querySelector(s) as T;
  q<HTMLButtonElement>("#exFrameBtn").addEventListener("click", () => {
    engine.renderFrame();
    canvas.toBlob((b) => {
      if (b) downloadBlob(b, `frame-${Date.now()}.png`);
    });
  });
  q<HTMLButtonElement>("#exGoBtn").addEventListener("click", async () => {
    const resSel = q<HTMLSelectElement>("#exRes").value;
    let W = p.width;
    let H = p.height;
    if (resSel.includes("x")) {
      [W, H] = resSel.split("x").map(Number);
    } else {
      const s = parseFloat(resSel);
      W = Math.round((p.width * s) / 2) * 2;
      H = Math.round((p.height * s) / 2) * 2;
    }
    const fps = parseInt(q<HTMLInputElement>("#exFps").value, 10);
    const br = parseFloat(q<HTMLInputElement>("#exBr").value) * 1_000_000;
    const useRange = q<HTMLInputElement>("#exRange").checked;
    const prog = q<HTMLDivElement>("#exProgress");
    const controller = new AbortController();
    try {
      const blob = await exportMp4(p, {
        width: W, height: H, fps, videoBitrate: br,
        inSec: useRange ? parseFloat(q<HTMLInputElement>("#exIn").value) : undefined,
        outSec: useRange ? parseFloat(q<HTMLInputElement>("#exOut").value) : undefined,
        signal: controller.signal,
        onProgress: (frac, msg) => (prog.textContent = `${(frac * 100).toFixed(0)}% — ${msg}`),
      });
      downloadBlob(blob, `${p.name}-${Date.now()}.mp4`);
      prog.textContent = "done ✓";
      setTimeout(() => modal.close(), 800);
    } catch (err) {
      prog.textContent = `failed: ${(err as Error).message}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Projects dialog
// ---------------------------------------------------------------------------
async function openProjectsDialog(): Promise<void> {
  const modal = makeModal("Projects");
  const projects = await listProjects();
  const list = document.createElement("div");
  list.className = "project-list";
  if (projects.length === 0) list.innerHTML = `<div class="muted-note">No saved projects.</div>`;
  for (const pr of projects) {
    const row = document.createElement("div");
    row.className = "project-row";
    row.innerHTML = `<span>${pr.name}</span><span class="muted-note">${new Date(pr.updatedAt).toLocaleString()}</span>`;
    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", async () => {
      await saveProject(store.getProject(), Date.now());
      const loaded = await loadProject(pr.id);
      if (loaded) {
        store.setProject(loaded);
        knownClipIds = new Set();
        await engine.preloadAll();
        engine.renderFrame();
        sizePreview();
      }
      modal.close();
    });
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "×";
    del.addEventListener("click", async () => {
      await deleteProject(pr.id);
      row.remove();
    });
    row.append(open, del);
    list.append(row);
  }
  modal.body.append(list);
}

// ---------------------------------------------------------------------------
// Modal + download helpers
// ---------------------------------------------------------------------------
function makeModal(title: string): { body: HTMLElement; close: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal";
  box.innerHTML = `<div class="modal-head"><h3>${title}</h3><button class="modal-x">×</button></div><div class="modal-body"></div>`;
  overlay.append(box);
  document.body.append(overlay);
  const close = () => overlay.remove();
  box.querySelector(".modal-x")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  return { body: box.querySelector(".modal-body")!, close };
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  const loaded = await loadProject();
  if (loaded) store.setProject(loaded);
  knownClipIds = new Set(store.getProject().clips.map((c) => c.id));
  zoomRange.value = String(store.ui.zoomPps);
  sizePreview();
  await engine.preloadAll();
  engine.renderFrame();
  store.emit(); // initial render of all panels (timeline, inspector, library)
  updateUndoButtons();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  }
}
void boot();
