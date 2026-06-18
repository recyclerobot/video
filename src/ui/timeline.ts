// Timeline: ruler, tracks, clips, drag/trim/fade, snapping, transitions,
// waveforms, keyframe markers, markers + range. Rebuilds on store changes;
// the playhead is moved imperatively during playback for smoothness.
import type { EditorStore } from "../state/store";
import type { PlaybackEngine } from "../engine/playback";
import { addTransition, removeTransition } from "../state/commands";
import { isAnimated, removeKeyframe } from "../engine/keyframes";
import { fmtTime } from "../util";
import { escapeHtml } from "../util";
import type {
  AudioClip,
  Clip,
  MediaAsset,
  SequenceClip,
  Track,
  TransitionType,
  VideoClip,
} from "../types";

const HEADER_W = 140;
const SNAP_PX = 8;

const TRANSITION_CYCLE: TransitionType[] = [
  "crossfade",
  "dip-black",
  "dip-white",
  "wipe",
  "slide",
];

export interface TimelineHooks {
  onDropMedia(mediaId: string, trackId: string, start: number): void;
}

export class Timeline {
  ruler: HTMLElement;
  tracks: HTMLElement;
  scroll: HTMLElement;

  constructor(
    root: HTMLElement,
    private store: EditorStore,
    private engine: PlaybackEngine,
    private hooks: TimelineHooks,
  ) {
    this.ruler = root.querySelector("#ruler")!;
    this.scroll = root.querySelector("#tracksScroll")!;
    this.tracks = root.querySelector("#tracksContainer")!;
    this.store.subscribe(() => this.render());
  }

  private get pps(): number {
    return this.store.ui.zoomPps;
  }
  private mediaById(id: string): MediaAsset | undefined {
    return this.store.getProject().media.find((m) => m.id === id);
  }

  // ---- snapping ----
  private snapTimes(excludeIds: Set<string>): number[] {
    const p = this.store.getProject();
    const pts: number[] = [0, this.engine.time];
    for (const c of p.clips) {
      if (excludeIds.has(c.id)) continue;
      pts.push(c.start, c.start + c.duration);
    }
    for (const m of p.markers) pts.push(m.time);
    return pts;
  }
  private snap(t: number, excludeIds: Set<string>): number {
    if (!this.store.ui.snapping) return t;
    const thresh = SNAP_PX / this.pps;
    let best = t;
    let bestD = thresh;
    for (const pt of this.snapTimes(excludeIds)) {
      const d = Math.abs(pt - t);
      if (d < bestD) {
        bestD = d;
        best = pt;
      }
    }
    return best;
  }

  render(): void {
    const p = this.store.getProject();
    const pps = this.pps;
    const dur = this.engine.duration();
    const totalW = Math.max(800, Math.ceil(dur * pps) + 200);

    // ruler
    this.ruler.textContent = "";
    this.ruler.style.width = totalW + HEADER_W + "px";
    this.ruler.style.paddingLeft = HEADER_W + "px";
    const step = pickStep(pps);
    for (let s = 0; s <= dur + step; s += step) {
      const tick = document.createElement("div");
      tick.className = "ruler-tick";
      tick.style.left = HEADER_W + s * pps + "px";
      tick.textContent = fmtTime(s);
      this.ruler.appendChild(tick);
    }
    // markers
    for (const m of p.markers) {
      const mk = document.createElement("div");
      mk.className = "ruler-marker";
      mk.style.left = HEADER_W + m.time * pps + "px";
      mk.style.background = m.color;
      mk.title = m.label;
      this.ruler.appendChild(mk);
    }
    // range shading
    if (p.inPoint != null && p.outPoint != null && p.outPoint > p.inPoint) {
      const r = document.createElement("div");
      r.className = "ruler-range";
      r.style.left = HEADER_W + p.inPoint * pps + "px";
      r.style.width = (p.outPoint - p.inPoint) * pps + "px";
      this.ruler.appendChild(r);
    }

    // tracks
    this.tracks.textContent = "";
    this.tracks.style.width = HEADER_W + totalW + "px";
    for (const tr of p.tracks) {
      this.tracks.appendChild(this.buildTrack(tr, totalW));
    }
    this.drawPlayhead();
  }

  private buildTrack(tr: Track, totalW: number): HTMLElement {
    const p = this.store.getProject();
    const trEl = document.createElement("div");
    trEl.className = "track";
    trEl.dataset.trackId = tr.id;

    const header = document.createElement("div");
    header.className = "track-header";
    const audioControls =
      tr.kind === "audio"
        ? `<div class="track-audio">
             <input type="range" min="0" max="2" step="0.01" value="${tr.gain ?? 1}" data-act="gain" data-id="${tr.id}" title="gain"/>
             <input type="range" min="-1" max="1" step="0.01" value="${tr.pan ?? 0}" data-act="pan" data-id="${tr.id}" title="pan"/>
           </div>`
        : "";
    header.innerHTML = `
      <div class="name" title="${escapeHtml(tr.name)}">${escapeHtml(tr.name)}</div>
      <div class="meta">
        <span>${tr.kind}</span>
        <button data-act="mute" data-id="${tr.id}" title="mute">${tr.muted ? "🔇" : "🔈"}</button>
        ${tr.kind === "audio" ? `<button data-act="solo" data-id="${tr.id}" title="solo" class="${tr.solo ? "on" : ""}">S</button>` : ""}
        <button data-act="hide" data-id="${tr.id}" title="hide">${tr.hidden ? "🚫" : "👁"}</button>
        <button data-act="lock" data-id="${tr.id}" title="lock">${tr.locked ? "🔒" : "🔓"}</button>
        <button data-act="rmtrack" data-id="${tr.id}" class="danger">×</button>
      </div>
      ${audioControls}`;
    trEl.appendChild(header);

    const lane = document.createElement("div");
    lane.className = "track-lane";
    lane.style.width = totalW + "px";
    lane.dataset.track = tr.id;
    trEl.appendChild(lane);

    // drop target
    lane.addEventListener("dragover", (ev) => ev.preventDefault());
    lane.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const mediaId = ev.dataTransfer?.getData("application/x-media-id");
      if (!mediaId) return;
      const x = ev.clientX - lane.getBoundingClientRect().left;
      const t = Math.max(0, x / this.pps);
      this.hooks.onDropMedia(mediaId, tr.id, this.snap(t, new Set()));
    });
    // click to seek
    lane.addEventListener("mousedown", (ev) => {
      if ((ev.target as HTMLElement).closest(".clip, .transition")) return;
      const x = ev.clientX - lane.getBoundingClientRect().left;
      this.engine.seek(Math.max(0, x / this.pps));
      if (!ev.shiftKey) this.store.setSelection([]);
    });

    // clips
    const clips = p.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    for (const c of clips) lane.appendChild(this.buildClip(c, tr));

    // transitions between adjacent video clips
    if (tr.kind === "video") this.buildTransitions(lane, tr, clips);

    // header buttons
    header.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
      const act = b.dataset.act!;
      if (b.tagName === "INPUT") return;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.trackAction(act, tr.id);
      });
    });
    header.querySelectorAll<HTMLInputElement>("input[data-act]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        this.store.update("Track " + inp.dataset.act, (pr) => {
          const t2 = pr.tracks.find((x) => x.id === tr.id);
          if (!t2) return;
          if (inp.dataset.act === "gain") t2.gain = v;
          else t2.pan = v;
        });
      });
    });

    return trEl;
  }

  private trackAction(act: string, id: string): void {
    if (act === "rmtrack") {
      if (!confirm("Delete track and its clips?")) return;
      this.store.update("Delete track", (p) => {
        p.tracks = p.tracks.filter((x) => x.id !== id);
        p.clips = p.clips.filter((c) => c.trackId !== id);
        p.transitions = p.transitions.filter((tr) => tr.trackId !== id);
      });
      this.engine.renderFrame();
      return;
    }
    this.store.update("Track " + act, (p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (!t) return;
      if (act === "mute") t.muted = !t.muted;
      if (act === "hide") t.hidden = !t.hidden;
      if (act === "lock") t.locked = !t.locked;
      if (act === "solo") t.solo = !t.solo;
    });
    this.engine.renderFrame();
  }

  private buildClip(c: Clip, tr: Track): HTMLElement {
    const pps = this.pps;
    const div = document.createElement("div");
    div.className = `clip ${c.kind}`;
    if (this.store.isSelected(c.id)) div.classList.add("selected");
    div.dataset.id = c.id;
    div.style.left = c.start * pps + "px";
    div.style.width = Math.max(8, c.duration * pps) + "px";

    const m = "mediaId" in c ? this.mediaById((c as VideoClip).mediaId) : undefined;
    if ((c.kind === "video" || c.kind === "image") && m?.thumbnail) {
      div.style.backgroundImage = `url(${m.thumbnail})`;
      div.style.backgroundSize = "auto 100%";
      div.style.backgroundRepeat = "repeat-x";
    }

    let label = "";
    if (c.kind === "video" || c.kind === "audio" || c.kind === "image" || c.kind === "sequence") {
      label = m?.name ?? "(missing)";
      if ("speed" in c && (c as VideoClip).speed !== 1) label += ` ·${(c as VideoClip).speed}×`;
    } else if (c.kind === "title") label = `T: ${(c.text.split("\n")[0] || "").slice(0, 24) || "(empty)"}`;
    else if (c.kind === "effect") label = `FX (${c.filters.length})`;

    div.innerHTML = `<div class="handle left"></div><span class="clip-label">${escapeHtml(label)}</span><div class="handle right"></div>`;

    // waveform for audio
    if (c.kind === "audio" && m?.peaks) {
      const cv = document.createElement("canvas");
      cv.className = "wave";
      const w = Math.max(8, c.duration * pps);
      cv.width = Math.round(w);
      cv.height = 40;
      cv.style.width = w + "px";
      div.appendChild(cv);
      drawWaveform(cv, m.peaks, m.duration, (c as AudioClip).inPoint, c.duration * (c as AudioClip).speed);
    }

    // fade handles + overlay for audio
    if (c.kind === "audio" || c.kind === "video") {
      const a = (c as AudioClip | VideoClip).audio;
      const fadeInEl = document.createElement("div");
      fadeInEl.className = "fade-handle in";
      fadeInEl.style.left = Math.min(40, (a.fadeIn / c.duration) * (c.duration * pps)) + "px";
      const fadeOutEl = document.createElement("div");
      fadeOutEl.className = "fade-handle out";
      fadeOutEl.style.right = Math.min(40, (a.fadeOut / c.duration) * (c.duration * pps)) + "px";
      div.appendChild(fadeInEl);
      div.appendChild(fadeOutEl);
      fadeInEl.addEventListener("mousedown", (e) => this.startFade(e, c.id, "in"));
      fadeOutEl.addEventListener("mousedown", (e) => this.startFade(e, c.id, "out"));
    }

    // keyframe markers for the active prop on a singly-selected clip
    this.buildKeyframeMarkers(div, c);

    // interactions
    div.addEventListener("mousedown", (e) => {
      const tEl = e.target as HTMLElement;
      if (tEl.classList.contains("handle") || tEl.classList.contains("fade-handle")) return;
      if (tr.locked) return;
      if (e.shiftKey) this.store.toggleSelection(c.id);
      else if (!this.store.isSelected(c.id)) this.store.setSelection([c.id]);
      this.startMove(e, c.id);
    });
    (div.querySelector(".handle.left") as HTMLElement).addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (tr.locked) return;
      this.store.setSelection([c.id]);
      this.startTrim(e, c.id, "left");
    });
    (div.querySelector(".handle.right") as HTMLElement).addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (tr.locked) return;
      this.store.setSelection([c.id]);
      this.startTrim(e, c.id, "right");
    });
    return div;
  }

  private buildKeyframeMarkers(div: HTMLElement, c: Clip): void {
    const sel = this.store.ui.selectedClipIds;
    const prop = this.store.ui.activeKeyframeProp;
    if (sel.length !== 1 || sel[0] !== c.id || !prop) return;
    const value = resolveProp(c, prop);
    if (!value || !isAnimated(value)) return;
    for (const k of value.keys) {
      const d = document.createElement("div");
      d.className = "kf-marker";
      d.style.left = k.time * this.pps + "px";
      d.title = `${prop} @ ${k.time.toFixed(2)}s = ${k.value}`;
      d.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        if (e.button === 2) return;
        this.engine.seek(c.start + k.time);
      });
      d.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.store.update("Remove keyframe", (p) => {
          const cc = p.clips.find((x) => x.id === c.id);
          if (cc) setProp(cc, prop, removeKeyframe(value, k.time));
        });
        this.engine.renderFrame();
      });
      div.appendChild(d);
    }
  }

  private buildTransitions(lane: HTMLElement, tr: Track, clips: Clip[]): void {
    const p = this.store.getProject();
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i];
      const b = clips[i + 1];
      const aEnd = a.start + a.duration;
      if (Math.abs(aEnd - b.start) > 0.06) continue; // only adjacent
      const existing = p.transitions.find(
        (t) => t.fromClipId === a.id && t.toClipId === b.id,
      );
      const badge = document.createElement("div");
      badge.className = "transition" + (existing ? " active" : "");
      if (existing && this.store.ui.selectedTransitionId === existing.id)
        badge.classList.add("selected");
      badge.style.left = b.start * this.pps - 9 + "px";
      badge.textContent = existing ? "⇄" : "+";
      badge.title = existing ? `${existing.type} (${existing.duration}s) — click to cycle, right-click to remove` : "add transition";
      badge.addEventListener("mousedown", (e) => e.stopPropagation());
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!existing) {
          addTransition(this.store, a.id, b.id, "crossfade", 0.5);
        } else {
          const idx = (TRANSITION_CYCLE.indexOf(existing.type) + 1) % TRANSITION_CYCLE.length;
          this.store.update("Transition type", (pp) => {
            const t = pp.transitions.find((x) => x.id === existing.id);
            if (t) t.type = TRANSITION_CYCLE[idx];
          });
          this.store.selectTransition(existing.id);
        }
        this.engine.renderFrame();
      });
      badge.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (existing) removeTransition(this.store, existing.id);
        this.engine.renderFrame();
      });
      lane.appendChild(badge);
    }
  }

  // ---- drags ----
  private startMove(ev: MouseEvent, clipId: string): void {
    ev.preventDefault();
    const startX = ev.clientX;
    this.store.beginTransaction("Move");
    const ids = this.store.ui.selectedClipIds.includes(clipId)
      ? [...this.store.ui.selectedClipIds]
      : [clipId];
    const p = this.store.getProject();
    const orig = new Map(ids.map((id) => [id, p.clips.find((c) => c.id === id)!.start]));
    const primaryOrig = orig.get(clipId)!;
    const exclude = new Set(ids);
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - startX) / this.pps;
      const desired = Math.max(0, primaryOrig + dx);
      const snapped = this.snap(desired, exclude);
      const delta = snapped - primaryOrig;
      this.store.mutateLive((pr) => {
        for (const id of ids) {
          const c = pr.clips.find((x) => x.id === id);
          if (c) c.start = Math.max(0, (orig.get(id) ?? 0) + delta);
        }
      });
      this.engine.renderFrame();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.store.commitTransaction();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private startTrim(ev: MouseEvent, clipId: string, side: "left" | "right"): void {
    ev.preventDefault();
    const startX = ev.clientX;
    this.store.beginTransaction("Trim");
    const p = this.store.getProject();
    const c0 = structuredClone(p.clips.find((c) => c.id === clipId)!);
    const exclude = new Set([clipId]);
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - startX) / this.pps;
      this.store.mutateLive((pr) => {
        const c = pr.clips.find((x) => x.id === clipId);
        if (!c) return;
        if (side === "left") {
          let newStart = this.snap(Math.max(0, c0.start + dx), exclude);
          const delta = newStart - c0.start;
          const newDur = c0.duration - delta;
          if (newDur < 0.05) return;
          c.start = newStart;
          c.duration = newDur;
          if (c.kind === "video" || c.kind === "audio")
            c.inPoint = Math.max(0, (c0 as VideoClip).inPoint + delta * (c0 as VideoClip).speed);
          else if (c.kind === "sequence")
            (c as SequenceClip).inFrame = Math.max(0, Math.round((c0 as SequenceClip).inFrame + delta * (c0 as SequenceClip).speed * (c0 as SequenceClip).sourceFps));
        } else {
          let newEnd = this.snap(c0.start + Math.max(0.05, c0.duration + dx), exclude);
          let newDur = Math.max(0.05, newEnd - c0.start);
          if (c.kind === "video" || c.kind === "audio") {
            const m = this.mediaById((c as VideoClip).mediaId);
            const speed = (c as VideoClip).speed;
            if (m && m.duration > 0) {
              const maxDur = Math.max(0.05, (m.duration - (c as VideoClip).inPoint) / speed);
              newDur = Math.min(newDur, maxDur);
            }
          }
          c.duration = newDur;
        }
      });
      this.engine.renderFrame();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.store.commitTransaction();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  private startFade(ev: MouseEvent, clipId: string, side: "in" | "out"): void {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    this.store.beginTransaction("Fade");
    const p = this.store.getProject();
    const c0 = structuredClone(p.clips.find((c) => c.id === clipId)!) as AudioClip | VideoClip;
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - startX) / this.pps;
      this.store.mutateLive((pr) => {
        const c = pr.clips.find((x) => x.id === clipId) as AudioClip | VideoClip | undefined;
        if (!c) return;
        if (side === "in") c.audio.fadeIn = Math.max(0, Math.min(c.duration, c0.audio.fadeIn + dx));
        else c.audio.fadeOut = Math.max(0, Math.min(c.duration, c0.audio.fadeOut - dx));
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this.store.commitTransaction();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---- playhead ----
  drawPlayhead(): void {
    let ph = this.tracks.querySelector<HTMLDivElement>("#playhead");
    if (!ph) {
      ph = document.createElement("div");
      ph.id = "playhead";
      ph.className = "playhead";
      this.tracks.appendChild(ph);
    }
    ph.style.left = HEADER_W + this.engine.time * this.pps + "px";
  }
  updatePlayhead(): void {
    this.drawPlayhead();
    // auto-scroll to keep playhead visible
    const x = HEADER_W + this.engine.time * this.pps;
    const view = this.scroll;
    if (x < view.scrollLeft + HEADER_W || x > view.scrollLeft + view.clientWidth - 40) {
      view.scrollLeft = x - view.clientWidth / 2;
    }
  }
}

function pickStep(pps: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  for (const c of candidates) if (c * pps >= 60) return c;
  return 60;
}

function drawWaveform(
  cv: HTMLCanvasElement,
  peaks: number[],
  mediaDur: number,
  inPoint: number,
  srcDur: number,
): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = cv;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(166,227,161,0.55)";
  const startIdx = (inPoint / mediaDur) * peaks.length;
  const spanIdx = (srcDur / mediaDur) * peaks.length;
  for (let x = 0; x < w; x++) {
    const pi = Math.floor(startIdx + (x / w) * spanIdx);
    const v = peaks[pi] ?? 0;
    const bh = v * (h - 4);
    ctx.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

// resolve "transform.x" / "audio.volume" style prop paths to an Animatable
function resolveProp(c: Clip, path: string): import("../types").Animatable | null {
  const parts = path.split(".");
  let obj: unknown = c;
  for (const part of parts) {
    if (obj && typeof obj === "object" && part in (obj as Record<string, unknown>))
      obj = (obj as Record<string, unknown>)[part];
    else return null;
  }
  if (typeof obj === "number" || (obj && typeof obj === "object" && "keys" in (obj as object)))
    return obj as import("../types").Animatable;
  return null;
}
function setProp(c: Clip, path: string, value: import("../types").Animatable): void {
  const parts = path.split(".");
  let obj: Record<string, unknown> = c as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]] as Record<string, unknown>;
  obj[parts[parts.length - 1]] = value;
}

export { resolveProp, setProp };
