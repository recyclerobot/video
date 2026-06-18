// Shared render path. Preview (engine/playback.ts) and export (export.ts) both
// call renderProject() with their own FrameProvider, guaranteeing WYSIWYG.
//
// Track order: project.tracks[0] is the TOP layer. We composite bottom→top so
// adjustment (effect) layers apply to everything already accumulated below them.
import type { Compositor } from "./compositor";
import { computeTitleAnim } from "./text";
import { sampleAt } from "./keyframes";
import {
  defaultTransform,
  isVisual,
  type Clip,
  type EffectClip,
  type Project,
  type TitleClip,
  type Track,
  type Transform,
  type Transition,
  type VisualClip,
} from "../types";

export interface SourceFrame {
  source: TexImageSource;
  w: number;
  h: number;
}

/** Supplies a ready-to-upload frame for a visual clip at a clip-local time. */
export interface FrameProvider {
  getSource(clip: VisualClip, localTime: number): SourceFrame | null;
}

const active = (c: Clip, t: number) => t >= c.start && t < c.start + c.duration;

/** Transition window: the last `duration` seconds before the incoming clip starts. */
function transitionWindow(
  tr: Transition,
  clips: Map<string, Clip>,
): { start: number; end: number; cut: number } | null {
  const to = clips.get(tr.toClipId);
  if (!to) return null;
  const cut = to.start;
  return { start: cut - tr.duration, end: cut, cut };
}

export function renderProject(
  comp: Compositor,
  p: Project,
  t: number,
  provider: FrameProvider,
): void {
  comp.setSize(p.width, p.height);
  for (const lut of p.luts) comp.uploadLut(lut);
  comp.clearAccum();

  const clipById = new Map(p.clips.map((c) => [c.id, c]));
  const bottomToTop = [...p.tracks].reverse();

  for (const tr of bottomToTop) {
    if (tr.hidden) continue;
    if (tr.kind === "audio") continue;
    if (tr.kind === "effect") {
      const fx = p.clips.filter(
        (c): c is EffectClip => c.kind === "effect" && c.trackId === tr.id && active(c, t),
      );
      for (const e of fx) comp.applyAdjustment(e.filters, t - e.start);
      continue;
    }
    renderVisualTrack(comp, p, tr, t, provider, clipById);
  }

  comp.present();
}

function renderVisualTrack(
  comp: Compositor,
  p: Project,
  tr: Track,
  t: number,
  provider: FrameProvider,
  clipById: Map<string, Clip>,
): void {
  const handled = new Set<string>();

  // transitions on this track whose window contains t
  for (const trans of p.transitions) {
    if (trans.trackId !== tr.id) continue;
    const win = transitionWindow(trans, clipById);
    if (!win) continue;
    if (t < win.start || t >= win.end) continue;
    const from = clipById.get(trans.fromClipId);
    const to = clipById.get(trans.toClipId);
    if (!from || !to || !isVisual(from) || !isVisual(to)) continue;
    const progress = (t - win.start) / Math.max(1e-6, win.end - win.start);
    const a = prepareLayerTex(comp, 0, from, t - from.start, provider);
    const b = prepareLayerTex(comp, 1, to, t - to.start, provider);
    if (a && b) comp.compositeTransition(a, b, progress, trans.type);
    else if (a) comp.compositeLayer(a, 1);
    else if (b) comp.compositeLayer(b, 1);
    handled.add(from.id);
    handled.add(to.id);
  }

  // plain active clips (sorted by start so later clips layer over earlier)
  const activeClips = p.clips
    .filter((c) => c.trackId === tr.id && isVisual(c) && active(c, t) && !handled.has(c.id))
    .sort((x, y) => x.start - y.start) as VisualClip[];
  for (const c of activeClips) {
    const tex = prepareLayerTex(comp, 0, c, t - c.start, provider);
    if (tex) comp.compositeLayer(tex, 1);
  }
}

function prepareLayerTex(
  comp: Compositor,
  slot: number,
  clip: VisualClip,
  localTime: number,
  provider: FrameProvider,
): WebGLTexture | null {
  const frame = provider.getSource(clip, localTime);
  if (!frame) return null;
  const key = `clip:${clip.id}`;
  const tex = comp.uploadSource(key, frame.source);

  let transform: Transform = (clip as { transform?: Transform }).transform ?? defaultTransform();
  let opacity = sampleAt(transform.opacity, localTime);
  const filters = (clip as { filters?: VisualClip["filters"] }).filters ?? [];

  if (clip.kind === "title") {
    const anim = computeTitleAnim(clip as TitleClip, localTime);
    opacity *= anim.opacity;
    transform = {
      ...transform,
      x: sampleAt(transform.x, localTime) + anim.dx,
      y: sampleAt(transform.y, localTime) + anim.dy,
      scale: sampleAt(transform.scale, localTime) * anim.scale,
    };
  }

  return comp.prepareLayer(
    slot,
    tex,
    frame.w,
    frame.h,
    transform,
    opacity,
    filters,
    localTime,
  );
}

/** Timeline duration honoring all clips. */
export function timelineDuration(p: Project): number {
  let max = 0;
  for (const c of p.clips) max = Math.max(max, c.start + c.duration);
  return max;
}
