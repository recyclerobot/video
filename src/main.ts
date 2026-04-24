import "./style.css";
import {
  defaultProject,
  newId,
  type Project,
  type Clip,
  type VideoClip,
  type AudioClip,
  type TitleClip,
  type EffectClip,
  type Track,
  type MediaAsset,
} from "./types";
import { putBlob, saveProject, loadProject, getBlob } from "./storage";
import { probeMedia, urlForMedia } from "./media";
import { PlaybackEngine, videoElCache } from "./playback";
import { exportMp4 } from "./export";

// ---------- STATE ----------
let project: Project = loadProject() ?? defaultProject();
let selection: { type: "clip"; id: string } | null = null;
let pixelsPerSecond = 80;

// ---------- DOM ----------
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="topbar">
    <h1>WebGL Video Editor</h1>
    <span class="status" id="status"></span>
    <div class="spacer"></div>
    <button id="addTitleBtn">+ Title</button>
    <button id="addEffectBtn">+ Effect</button>
    <button id="addVideoTrackBtn">+ Video Track</button>
    <button id="addAudioTrackBtn">+ Audio Track</button>
    <button id="newProjectBtn" class="danger">New</button>
    <button id="exportBtn" class="primary">Export MP4</button>
  </header>
  <aside class="panel library">
    <h2>Media Library</h2>
    <div class="body" id="libraryBody">
      <input type="file" id="fileInput" accept="video/*,audio/*" multiple />
      <div id="mediaList" style="margin-top:10px;display:flex;flex-direction:column;gap:4px;"></div>
    </div>
  </aside>
  <section class="preview">
    <div class="canvas-wrap" id="canvasWrap">
      <div style="position:relative;display:inline-block;">
        <canvas id="previewCanvas"></canvas>
        <canvas id="overlayCanvas" style="position:absolute;left:0;top:0;pointer-events:none;"></canvas>
      </div>
    </div>
    <div class="transport">
      <button id="playBtn">▶</button>
      <button id="stopBtn">■</button>
      <span class="time" id="timeDisplay">00:00.00 / 00:00.00</span>
      <input type="range" id="seek" min="0" max="100" step="0.01" value="0" style="flex:1" />
      <label style="font-size:11px;color:var(--muted);">Zoom</label>
      <input type="range" id="zoom" min="20" max="300" value="80" step="1" style="width:120px" />
    </div>
  </section>
  <aside class="panel inspector">
    <h2>Inspector</h2>
    <div class="body" id="inspectorBody">
      <div style="color:var(--muted);font-size:12px;">Select a clip to edit.</div>
    </div>
  </aside>
  <section class="timeline">
    <div class="toolbar">
      <button id="splitBtn" title="Split selected clip at playhead">Split</button>
      <button id="deleteBtn" class="danger" title="Delete selected clip">Delete</button>
      <span class="status" id="tlStatus" style="margin-left:8px;color:var(--muted);font-size:11px;"></span>
    </div>
    <div class="ruler" id="ruler"></div>
    <div class="tracks-scroll" id="tracksScroll">
      <div id="tracksContainer"></div>
    </div>
  </section>
`;

const canvas = document.getElementById("previewCanvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlayCanvas") as HTMLCanvasElement;
const engine = new PlaybackEngine(project, canvas, overlay);
sizePreviewCanvases();

// Apply preview canvas CSS sizing to fit container while preserving aspect.
function sizePreviewCanvases(): void {
  const wrap = document.getElementById("canvasWrap")!;
  const r = wrap.getBoundingClientRect();
  const ar = project.width / project.height;
  let w = r.width - 24, h = r.height - 24;
  if (w / h > ar) w = h * ar; else h = w / ar;
  for (const c of [canvas, overlay]) {
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }
}
window.addEventListener("resize", () => {
  sizePreviewCanvases();
  drawTimeline();
});

// ---------- PERSISTENCE / SAVE ----------
let saveTimer = 0;
function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveProject(project);
    setStatus("saved");
  }, 200);
}

function setStatus(msg: string): void {
  const el = document.getElementById("status")!;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 1500);
}

// ---------- TIME UTILS ----------
function fmtTime(t: number): string {
  const mm = Math.floor(t / 60);
  const ss = (t - mm * 60);
  return `${String(mm).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}`;
}

// ---------- LIBRARY ----------
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
fileInput.addEventListener("change", async () => {
  if (!fileInput.files) return;
  for (const f of Array.from(fileInput.files)) {
    await importFile(f);
  }
  fileInput.value = "";
  renderLibrary();
  persist();
});

async function importFile(file: File): Promise<MediaAsset | null> {
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
    project.media.push(asset);
    return asset;
  } catch (e) {
    console.error(e);
    setStatus(`failed to import ${file.name}`);
    return null;
  }
}

function renderLibrary(): void {
  const list = document.getElementById("mediaList")!;
  list.innerHTML = "";
  for (const m of project.media) {
    const div = document.createElement("div");
    div.className = "lib-item";
    div.draggable = true;
    div.innerHTML = `
      <div class="thumb" style="${m.thumbnail ? `background-image:url(${m.thumbnail});` : "background:#222;"}"></div>
      <div style="min-width:0;flex:1;">
        <div class="name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
        <div class="dur">${m.type} · ${fmtTime(m.duration)}</div>
      </div>
      <button data-del="${m.id}" class="danger" style="padding:2px 6px;">×</button>
    `;
    div.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("application/x-media-id", m.id);
    });
    div.addEventListener("dblclick", () => addMediaToTimeline(m));
    list.appendChild(div);
  }
  list.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.getAttribute("data-del")!;
      project.media = project.media.filter((m) => m.id !== id);
      project.clips = project.clips.filter((c) => !("mediaId" in c) || c.mediaId !== id);
      renderLibrary();
      drawTimeline();
      persist();
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
}

async function addMediaToTimeline(m: MediaAsset, trackId?: string, start?: number): Promise<void> {
  const kind: "video" | "audio" = m.type;
  const track = (trackId ? project.tracks.find((t) => t.id === trackId) : null)
    ?? project.tracks.find((t) => t.kind === kind);
  if (!track) return;
  const startT = start ?? endOfTrack(track.id);
  const clip: Clip = kind === "video"
    ? {
        id: newId("c"),
        kind: "video",
        trackId: track.id,
        mediaId: m.id,
        start: startT,
        duration: m.duration,
        inPoint: 0,
        speed: 1,
        useOwnAudio: true,
        volume: 1,
      } as VideoClip
    : {
        id: newId("c"),
        kind: "audio",
        trackId: track.id,
        mediaId: m.id,
        start: startT,
        duration: m.duration,
        inPoint: 0,
        speed: 1,
        volume: 1,
      } as AudioClip;
  project.clips.push(clip);
  await preloadClip(clip);
  drawTimeline();
  persist();
}

function endOfTrack(trackId: string): number {
  let max = 0;
  for (const c of project.clips) {
    if (c.trackId === trackId) max = Math.max(max, c.start + c.duration);
  }
  return max;
}

// ---------- PRELOAD CLIP ELEMENTS (so playback engine has them) ----------
async function preloadClip(c: Clip): Promise<void> {
  if (c.kind !== "video") return;
  if (videoElCache.has(c.id)) return;
  try {
    const url = await urlForMedia(c.mediaId);
    const v = document.createElement("video");
    v.src = url;
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    v.muted = !c.useOwnAudio;
    v.playsInline = true;
    v.volume = c.volume;
    await new Promise<void>((res) => {
      if (v.readyState >= 2) res();
      else v.addEventListener("loadeddata", () => res(), { once: true });
    });
    videoElCache.set(c.id, v);
    engine.renderFrame();
  } catch (e) {
    console.warn("preloadClip failed", e);
  }
}

// ---------- TIMELINE ----------
const ruler = document.getElementById("ruler")!;
const tracksContainer = document.getElementById("tracksContainer")!;
const tracksScroll = document.getElementById("tracksScroll")!;

function drawTimeline(): void {
  // Ruler
  const dur = engine.duration();
  const totalW = Math.max(800, Math.ceil(dur * pixelsPerSecond) + 200);
  ruler.innerHTML = "";
  ruler.style.width = totalW + 140 + "px";
  ruler.style.marginLeft = "0";
  // Padding for sticky track header width
  const headerW = 140;
  ruler.style.paddingLeft = headerW + "px";
  const step = pickRulerStep(pixelsPerSecond);
  for (let s = 0; s <= dur + step; s += step) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = headerW + s * pixelsPerSecond + "px";
    tick.textContent = fmtTime(s);
    ruler.appendChild(tick);
  }

  // Tracks
  tracksContainer.innerHTML = "";
  tracksContainer.style.width = headerW + totalW + "px";
  for (const tr of project.tracks) {
    const trEl = document.createElement("div");
    trEl.className = "track";
    trEl.dataset.trackId = tr.id;
    trEl.innerHTML = `
      <div class="track-header">
        <div class="name">${escapeHtml(tr.name)}</div>
        <div class="meta">
          <span>${tr.kind}</span>
          <button data-act="mute" data-id="${tr.id}">${tr.muted ? "🔇" : "🔈"}</button>
          <button data-act="hide" data-id="${tr.id}">${tr.hidden ? "🚫" : "👁"}</button>
          <button data-act="rmtrack" data-id="${tr.id}" class="danger">×</button>
        </div>
      </div>
      <div class="track-lane" data-track="${tr.id}" style="width:${totalW}px;"></div>
    `;
    tracksContainer.appendChild(trEl);

    const lane = trEl.querySelector(".track-lane") as HTMLDivElement;
    // Drop target
    lane.addEventListener("dragover", (ev) => { ev.preventDefault(); });
    lane.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      const mediaId = ev.dataTransfer?.getData("application/x-media-id");
      if (!mediaId) return;
      const m = project.media.find((x) => x.id === mediaId);
      if (!m) return;
      // Reject mismatch (drop video onto audio track or vice versa)
      if ((tr.kind === "video" && m.type !== "video") || (tr.kind === "audio" && m.type !== "audio")) {
        setStatus(`can't drop ${m.type} on ${tr.kind} track`);
        return;
      }
      const x = ev.clientX - lane.getBoundingClientRect().left;
      const t = Math.max(0, x / pixelsPerSecond);
      await addMediaToTimeline(m, tr.id, t);
    });
    // Click to seek (when not on a clip)
    lane.addEventListener("mousedown", (ev) => {
      if ((ev.target as HTMLElement).closest(".clip")) return;
      const x = ev.clientX - lane.getBoundingClientRect().left;
      engine.seek(Math.max(0, x / pixelsPerSecond));
    });

    // Render clips
    for (const c of project.clips) {
      if (c.trackId !== tr.id) continue;
      lane.appendChild(makeClipEl(c));
    }
  }

  // Track header buttons
  tracksContainer.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.dataset.id!;
      const act = b.dataset.act;
      const tr = project.tracks.find((x) => x.id === id);
      if (!tr) return;
      if (act === "mute") tr.muted = !tr.muted;
      if (act === "hide") tr.hidden = !tr.hidden;
      if (act === "rmtrack") {
        if (!confirm(`Delete track "${tr.name}" and its clips?`)) return;
        project.tracks = project.tracks.filter((x) => x.id !== id);
        project.clips = project.clips.filter((c) => c.trackId !== id);
      }
      drawTimeline();
      engine.renderFrame();
      persist();
    });
  });

  drawPlayhead();
}

function pickRulerStep(pps: number): number {
  // pick a step (in seconds) so ticks are at least 60px apart
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  for (const c of candidates) if (c * pps >= 60) return c;
  return 60;
}

function makeClipEl(c: Clip): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `clip ${c.kind}`;
  if (selection?.id === c.id) div.classList.add("selected");
  div.dataset.id = c.id;
  div.style.left = c.start * pixelsPerSecond + "px";
  div.style.width = Math.max(8, c.duration * pixelsPerSecond) + "px";
  let label = "";
  if (c.kind === "video" || c.kind === "audio") {
    const m = project.media.find((x) => x.id === c.mediaId);
    label = m?.name ?? "(missing media)";
    if (c.speed !== 1) label += ` ·${c.speed}×`;
  } else if (c.kind === "title") label = `T: ${c.text.split("\n")[0].slice(0, 30) || "(empty)"}`;
  else if (c.kind === "effect") label = "FX";
  div.innerHTML = `<div class="handle left"></div><span>${escapeHtml(label)}</span><div class="handle right"></div>`;

  // Selection
  div.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).classList.contains("handle")) return;
    selection = { type: "clip", id: c.id };
    renderInspector();
    drawTimeline();
    startDrag(e, c, "move");
  });
  (div.querySelector(".handle.left") as HTMLDivElement).addEventListener("mousedown", (e) => {
    e.stopPropagation();
    selection = { type: "clip", id: c.id };
    renderInspector();
    startDrag(e, c, "trim-left");
  });
  (div.querySelector(".handle.right") as HTMLDivElement).addEventListener("mousedown", (e) => {
    e.stopPropagation();
    selection = { type: "clip", id: c.id };
    renderInspector();
    startDrag(e, c, "trim-right");
  });
  return div;
}

function startDrag(ev: MouseEvent, clip: Clip, mode: "move" | "trim-left" | "trim-right"): void {
  ev.preventDefault();
  const startX = ev.clientX;
  const orig = { ...clip };
  const onMove = (e: MouseEvent) => {
    const dx = (e.clientX - startX) / pixelsPerSecond;
    const target = project.clips.find((c) => c.id === clip.id);
    if (!target) return;
    if (mode === "move") {
      target.start = Math.max(0, orig.start + dx);
    } else if (mode === "trim-left") {
      const newStart = Math.max(0, orig.start + dx);
      const delta = newStart - orig.start;
      const newDur = orig.duration - delta;
      if (newDur < 0.05) return;
      target.start = newStart;
      target.duration = newDur;
      // Adjust source in-point for media clips (account for speed)
      if (target.kind === "video" || target.kind === "audio") {
        const speed = (target as VideoClip | AudioClip).speed;
        (target as VideoClip | AudioClip).inPoint = Math.max(
          0,
          (orig as VideoClip | AudioClip).inPoint + delta * speed,
        );
      }
    } else {
      const newDur = Math.max(0.05, orig.duration + dx);
      // Clamp media clips by source duration
      if (target.kind === "video" || target.kind === "audio") {
        const m = project.media.find((mm) => mm.id === (target as VideoClip | AudioClip).mediaId);
        const speed = (target as VideoClip | AudioClip).speed;
        const maxDur = m
          ? Math.max(0.05, (m.duration - (target as VideoClip | AudioClip).inPoint) / speed)
          : newDur;
        target.duration = Math.min(newDur, maxDur);
      } else {
        target.duration = newDur;
      }
    }
    drawTimeline();
    engine.renderFrame();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    persist();
    renderInspector();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function drawPlayhead(): void {
  let ph = document.getElementById("playhead") as HTMLDivElement | null;
  if (!ph) {
    ph = document.createElement("div");
    ph.className = "playhead";
    ph.id = "playhead";
    tracksContainer.appendChild(ph);
  } else if (ph.parentElement !== tracksContainer) {
    tracksContainer.appendChild(ph);
  }
  const headerW = 140;
  ph.style.left = headerW + engine.time * pixelsPerSecond + "px";
}

// ---------- INSPECTOR ----------
function renderInspector(): void {
  const body = document.getElementById("inspectorBody")!;
  if (!selection) {
    body.innerHTML = `<div style="color:var(--muted);font-size:12px;">Select a clip to edit.</div>`;
    return;
  }
  const c = project.clips.find((x) => x.id === selection!.id);
  if (!c) {
    body.innerHTML = `<div style="color:var(--muted);font-size:12px;">Clip not found.</div>`;
    selection = null;
    return;
  }
  body.innerHTML = "";
  body.appendChild(commonControls(c));
  if (c.kind === "video") body.appendChild(videoControls(c));
  if (c.kind === "audio") body.appendChild(audioControls(c));
  if (c.kind === "title") body.appendChild(titleControls(c));
  if (c.kind === "effect") body.appendChild(effectControls(c));
}

function commonControls(c: Clip): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="section-title">Clip</div>
    <div class="row"><label>Start</label><input type="number" step="0.01" value="${c.start.toFixed(2)}" data-k="start" /></div>
    <div class="row"><label>Duration</label><input type="number" step="0.01" min="0.05" value="${c.duration.toFixed(2)}" data-k="duration" /></div>
  `;
  bindInputs(wrap, c, ["start", "duration"]);
  return wrap;
}

function videoControls(c: VideoClip): HTMLElement {
  const wrap = document.createElement("div");
  const m = project.media.find((mm) => mm.id === c.mediaId);
  wrap.innerHTML = `
    <div class="section-title">Video</div>
    <div class="row"><label>Source</label><div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(m?.name ?? "")}">${escapeHtml(m?.name ?? "(missing)")}</div></div>
    <div class="row"><label>In point</label><input type="number" step="0.01" min="0" value="${c.inPoint.toFixed(2)}" data-k="inPoint" /></div>
    <div class="row"><label>Speed</label><input type="number" step="0.1" min="0.1" max="8" value="${c.speed}" data-k="speed" /></div>
    <div class="row"><label>Volume</label><input type="range" min="0" max="1" step="0.01" value="${c.volume}" data-k="volume" /></div>
    <div class="row"><label>Use audio</label><input type="checkbox" data-k="useOwnAudio" ${c.useOwnAudio ? "checked" : ""} /></div>
    <div class="section-title">Audio decoupling</div>
    <div class="row">
      <button id="decoupleBtn" style="flex:1;">Extract audio to new clip</button>
    </div>
  `;
  bindInputs(wrap, c, ["inPoint", "speed", "volume", "useOwnAudio"]);
  wrap.querySelector("#decoupleBtn")!.addEventListener("click", () => decoupleAudio(c));
  return wrap;
}

function audioControls(c: AudioClip): HTMLElement {
  const wrap = document.createElement("div");
  const m = project.media.find((mm) => mm.id === c.mediaId);
  wrap.innerHTML = `
    <div class="section-title">Audio</div>
    <div class="row"><label>Source</label><div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m?.name ?? "(missing)")}</div></div>
    <div class="row"><label>In point</label><input type="number" step="0.01" min="0" value="${c.inPoint.toFixed(2)}" data-k="inPoint" /></div>
    <div class="row"><label>Speed</label><input type="number" step="0.1" min="0.1" max="8" value="${c.speed}" data-k="speed" /></div>
    <div class="row"><label>Volume</label><input type="range" min="0" max="2" step="0.01" value="${c.volume}" data-k="volume" /></div>
  `;
  bindInputs(wrap, c, ["inPoint", "speed", "volume"]);
  return wrap;
}

function titleControls(c: TitleClip): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="section-title">Title</div>
    <div class="row"><label>Text</label></div>
    <textarea data-k="text" rows="3" style="width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:6px;font-size:12px;">${escapeHtml(c.text)}</textarea>
    <div class="row"><label>Font size</label><input type="number" min="8" max="400" value="${c.fontSize}" data-k="fontSize" /></div>
    <div class="row"><label>Color</label><input type="color" value="${c.color}" data-k="color" /></div>
    <div class="row"><label>BG color</label><input type="color" value="${c.bgColor === "transparent" ? "#000000" : c.bgColor}" data-k="bgColor" />
      <button id="bgTransparentBtn" style="margin-left:6px;">×</button></div>
    <div class="row"><label>X (0–1)</label><input type="number" step="0.01" min="0" max="1" value="${c.x}" data-k="x" /></div>
    <div class="row"><label>Y (0–1)</label><input type="number" step="0.01" min="0" max="1" value="${c.y}" data-k="y" /></div>
  `;
  bindInputs(wrap, c, ["text", "fontSize", "color", "bgColor", "x", "y"]);
  wrap.querySelector("#bgTransparentBtn")!.addEventListener("click", () => {
    c.bgColor = "transparent";
    persist(); engine.renderFrame(); renderInspector();
  });
  return wrap;
}

function effectControls(c: EffectClip): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="section-title">Effect (applies to layers below)</div>
    <div class="row"><label>Brightness</label><input type="range" min="0" max="2" step="0.01" value="${c.brightness}" data-k="brightness" /></div>
    <div class="row"><label>Contrast</label><input type="range" min="0" max="2" step="0.01" value="${c.contrast}" data-k="contrast" /></div>
    <div class="row"><label>Saturation</label><input type="range" min="0" max="2" step="0.01" value="${c.saturation}" data-k="saturation" /></div>
    <div class="row"><label>Hue</label><input type="range" min="-180" max="180" step="1" value="${c.hue}" data-k="hue" /></div>
    <div class="row"><label>Tint</label><input type="color" value="${c.tint}" data-k="tint" /></div>
    <div class="row"><label>Tint amt</label><input type="range" min="0" max="1" step="0.01" value="${c.tintAmount}" data-k="tintAmount" /></div>
  `;
  bindInputs(wrap, c, ["brightness", "contrast", "saturation", "hue", "tint", "tintAmount"]);
  return wrap;
}

function bindInputs<T extends Clip>(root: HTMLElement, clip: T, keys: (keyof T)[]): void {
  for (const k of keys) {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-k="${String(k)}"]`);
    if (!el) continue;
    el.addEventListener("input", () => {
      let v: unknown;
      if (el instanceof HTMLInputElement && el.type === "checkbox") v = el.checked;
      else if (el instanceof HTMLInputElement && (el.type === "number" || el.type === "range")) v = parseFloat(el.value);
      else v = el.value;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (clip as any)[k] = v;
      drawTimeline();
      engine.renderFrame();
      // sync media element if relevant
      if ((k === "useOwnAudio" || k === "volume") && (clip as Clip).kind === "video") {
        const v2 = clip as unknown as VideoClip;
        const el2 = videoElCache.get(v2.id);
        if (el2) { el2.muted = !v2.useOwnAudio; el2.volume = v2.volume; }
      }
      persist();
    });
  }
}

// ---------- ACTIONS ----------
function decoupleAudio(c: VideoClip): void {
  c.useOwnAudio = false;
  const audioTrack = project.tracks.find((t) => t.kind === "audio") ?? addTrack("audio", "Audio");
  const audio: AudioClip = {
    id: newId("c"),
    kind: "audio",
    trackId: audioTrack.id,
    mediaId: c.mediaId,
    start: c.start,
    duration: c.duration,
    inPoint: c.inPoint,
    speed: c.speed,
    volume: 1,
  };
  project.clips.push(audio);
  selection = { type: "clip", id: audio.id };
  drawTimeline();
  renderInspector();
  persist();
  setStatus("audio decoupled");
}

function addTrack(kind: Track["kind"], name: string): Track {
  const tr: Track = { id: newId("t"), kind, name };
  project.tracks.push(tr);
  return tr;
}

function addTitleClip(): void {
  const tr = project.tracks.find((t) => t.kind === "title") ?? addTrack("title", "Titles");
  const c: TitleClip = {
    id: newId("c"), kind: "title", trackId: tr.id,
    start: engine.time, duration: 3,
    text: "Title", fontSize: 64, color: "#ffffff", bgColor: "transparent",
    x: 0.5, y: 0.5,
  };
  project.clips.push(c);
  selection = { type: "clip", id: c.id };
  drawTimeline(); renderInspector(); engine.renderFrame(); persist();
}

function addEffectClip(): void {
  const tr = project.tracks.find((t) => t.kind === "effect") ?? addTrack("effect", "Effects");
  const c: EffectClip = {
    id: newId("c"), kind: "effect", trackId: tr.id,
    start: engine.time, duration: 3,
    brightness: 1, contrast: 1, saturation: 1, hue: 0, tint: "#000000", tintAmount: 0,
  };
  project.clips.push(c);
  selection = { type: "clip", id: c.id };
  drawTimeline(); renderInspector(); engine.renderFrame(); persist();
}

function splitSelected(): void {
  if (!selection) return;
  const c = project.clips.find((x) => x.id === selection!.id);
  if (!c) return;
  const t = engine.time;
  if (t <= c.start || t >= c.start + c.duration) {
    setStatus("playhead must be inside the clip");
    return;
  }
  const offset = t - c.start;
  const right: Clip = { ...c, id: newId("c"), start: t, duration: c.duration - offset };
  if (right.kind === "video" || right.kind === "audio") {
    const speed = (c as VideoClip | AudioClip).speed;
    (right as VideoClip | AudioClip).inPoint = (c as VideoClip | AudioClip).inPoint + offset * speed;
  }
  c.duration = offset;
  project.clips.push(right);
  drawTimeline(); persist();
}

function deleteSelected(): void {
  if (!selection) return;
  const id = selection.id;
  project.clips = project.clips.filter((x) => x.id !== id);
  engine.disposeClip(id);
  selection = null;
  drawTimeline(); renderInspector(); engine.renderFrame(); persist();
}

// ---------- TRANSPORT / TIME UI ----------
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const seekRange = document.getElementById("seek") as HTMLInputElement;
const zoomRange = document.getElementById("zoom") as HTMLInputElement;
const timeDisplay = document.getElementById("timeDisplay") as HTMLSpanElement;

playBtn.addEventListener("click", () => {
  if (engine.playing) { engine.pause(); playBtn.textContent = "▶"; }
  else { engine.play(); playBtn.textContent = "❚❚"; }
});
stopBtn.addEventListener("click", () => { engine.pause(); engine.seek(0); playBtn.textContent = "▶"; });
seekRange.addEventListener("input", () => {
  const dur = engine.duration();
  engine.seek((parseFloat(seekRange.value) / 100) * dur);
});
zoomRange.addEventListener("input", () => {
  pixelsPerSecond = parseInt(zoomRange.value, 10);
  drawTimeline();
});

engine.onTime = (t) => {
  const dur = engine.duration();
  timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
  seekRange.value = String((t / dur) * 100);
  drawPlayhead();
};

document.getElementById("addTitleBtn")!.addEventListener("click", addTitleClip);
document.getElementById("addEffectBtn")!.addEventListener("click", addEffectClip);
document.getElementById("addVideoTrackBtn")!.addEventListener("click", () => {
  addTrack("video", `Video ${project.tracks.filter((t) => t.kind === "video").length + 1}`);
  drawTimeline(); persist();
});
document.getElementById("addAudioTrackBtn")!.addEventListener("click", () => {
  addTrack("audio", `Audio ${project.tracks.filter((t) => t.kind === "audio").length + 1}`);
  drawTimeline(); persist();
});
document.getElementById("splitBtn")!.addEventListener("click", splitSelected);
document.getElementById("deleteBtn")!.addEventListener("click", deleteSelected);
document.getElementById("newProjectBtn")!.addEventListener("click", () => {
  if (!confirm("Discard current project?")) return;
  project = defaultProject();
  engine.setProject(project);
  selection = null;
  videoElCache.clear();
  saveProject(project);
  renderLibrary(); drawTimeline(); renderInspector();
  engine.renderFrame();
});
document.getElementById("exportBtn")!.addEventListener("click", () => doExport());

// ---------- KEYBOARD ----------
window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
  if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
  else if (e.code === "Delete" || e.code === "Backspace") { deleteSelected(); }
  else if (e.key === "s" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); splitSelected(); }
});

// ---------- EXPORT ----------
async function doExport(): Promise<void> {
  if (engine.playing) engine.pause();
  const toast = showToast("Preparing export…");
  try {
    const blob = await exportMp4(project, {
      onProgress: (frac, msg) => { toast.set(`${(frac * 100).toFixed(0)}% — ${msg}`); },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `export-${Date.now()}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast.set("export complete ✓");
    setTimeout(() => toast.dismiss(), 2000);
  } catch (e) {
    console.error(e);
    toast.set(`export failed: ${(e as Error).message}`);
    setTimeout(() => toast.dismiss(), 4000);
  }
}

function showToast(msg: string): { set(s: string): void; dismiss(): void } {
  const div = document.createElement("div");
  div.className = "toast";
  div.textContent = msg;
  document.body.appendChild(div);
  return {
    set(s) { div.textContent = s; },
    dismiss() { div.remove(); },
  };
}

// ---------- BOOT ----------
async function boot(): Promise<void> {
  // Make sure media blobs from a previous session are still in IndexedDB.
  const missing: string[] = [];
  for (const m of project.media) {
    const b = await getBlob(m.id);
    if (!b) missing.push(m.id);
  }
  if (missing.length) {
    setStatus(`${missing.length} media file(s) missing — re-import to restore`);
    project.media = project.media.filter((m) => !missing.includes(m.id));
    project.clips = project.clips.filter((c) => !("mediaId" in c) || !missing.includes((c as VideoClip | AudioClip).mediaId));
  }
  // Preload video clips.
  for (const c of project.clips) {
    if (c.kind === "video") await preloadClip(c);
  }
  renderLibrary();
  drawTimeline();
  renderInspector();
  engine.renderFrame();
  sizePreviewCanvases();
}
void boot();
