// Web Audio mixer. One graph-builder drives both real-time preview and the
// offline export mix, so what you hear is what you render: per-clip volume
// automation + fades + pan, per-track gain/pan/solo/mute, master gain.
import { sampleAt } from "./keyframes";
import { hasAudio, type AudioProps, type Clip, type Project, type Track } from "../types";

type AnyAudioContext = AudioContext | OfflineAudioContext;

export interface ClipAudioSource {
  clip: Clip;
  track: Track;
  audio: AudioProps;
  mediaId: string;
  speed: number;
  inPoint: number;
}

/** Collect audio-producing clips (audio clips + video clips using own audio). */
export function audioSources(p: Project): ClipAudioSource[] {
  const trackById = new Map(p.tracks.map((t) => [t.id, t]));
  const anySolo = p.tracks.some((t) => t.kind === "audio" && t.solo);
  const out: ClipAudioSource[] = [];
  for (const c of p.clips) {
    if (!hasAudio(c)) continue;
    if (c.kind === "video" && !c.useOwnAudio) continue;
    const track = trackById.get(c.trackId);
    if (!track) continue;
    if (track.muted) continue;
    if (anySolo && track.kind === "audio" && !track.solo) continue;
    out.push({
      clip: c,
      track,
      audio: c.audio,
      mediaId: c.mediaId,
      speed: c.speed,
      inPoint: c.inPoint,
    });
  }
  return out;
}

function fadeFactor(local: number, dur: number, a: AudioProps): number {
  let f = 1;
  if (a.fadeIn > 0 && local < a.fadeIn) f = Math.min(f, local / a.fadeIn);
  if (a.fadeOut > 0 && local > dur - a.fadeOut)
    f = Math.min(f, Math.max(0, (dur - local) / a.fadeOut));
  return Math.max(0, f);
}

/** Combined linear gain at clip-local time (volume automation × fades). */
function gainAt(local: number, dur: number, a: AudioProps): number {
  return Math.max(0, sampleAt(a.volume, local)) * fadeFactor(local, dur, a);
}

function breakpointTimes(src: ClipAudioSource): number[] {
  const dur = src.clip.duration;
  const set = new Set<number>([0, dur]);
  if (src.audio.fadeIn > 0) {
    set.add(src.audio.fadeIn);
  }
  if (src.audio.fadeOut > 0) set.add(dur - src.audio.fadeOut);
  if (typeof src.audio.volume !== "number")
    for (const k of src.audio.volume.keys) set.add(k.time);
  if (typeof src.audio.pan !== "number")
    for (const k of src.audio.pan.keys) set.add(k.time);
  return [...set].filter((t) => t >= 0 && t <= dur).sort((x, y) => x - y);
}

export interface ScheduleOpts {
  /** ctx time corresponding to `fromTime` on the timeline. */
  timeBaseCtx: number;
  /** timeline time at which playback begins (preview seek / 0 for export). */
  fromTime: number;
  master: number;
}

/** Build + schedule one clip's audio onto the destination. Returns the source node. */
export function scheduleClipAudio(
  ctx: AnyAudioContext,
  destination: AudioNode,
  src: ClipAudioSource,
  buffer: AudioBuffer,
  opts: ScheduleOpts,
): AudioBufferSourceNode | null {
  const { clip, track, audio, speed, inPoint } = src;
  const dur = clip.duration;
  const elapsed = Math.max(0, opts.fromTime - clip.start);
  if (elapsed >= dur) return null;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = speed;

  const gainNode = ctx.createGain();
  const panNode = ctx.createStereoPanner();

  const trackGain = track.gain ?? 1;
  const masterGain = opts.master;

  // gain breakpoints
  const whenStart = opts.timeBaseCtx + Math.max(0, clip.start - opts.fromTime);
  const bps = breakpointTimes(src).filter((t) => t >= elapsed - 1e-6);
  const ctxFor = (local: number) => whenStart + (local - elapsed);

  const g0 = gainAt(elapsed, dur, audio) * trackGain * masterGain;
  gainNode.gain.setValueAtTime(g0, Math.max(ctx.currentTime, whenStart));
  for (const local of bps) {
    if (local <= elapsed) continue;
    const g = gainAt(local, dur, audio) * trackGain * masterGain;
    gainNode.gain.linearRampToValueAtTime(g, ctxFor(local));
  }

  // pan breakpoints
  const trackPan = track.pan ?? 0;
  const panAt = (local: number) =>
    Math.max(-1, Math.min(1, sampleAt(audio.pan, local) + trackPan));
  panNode.pan.setValueAtTime(panAt(elapsed), Math.max(ctx.currentTime, whenStart));
  if (typeof audio.pan !== "number") {
    for (const k of audio.pan.keys) {
      if (k.time <= elapsed || k.time > dur) continue;
      panNode.pan.linearRampToValueAtTime(panAt(k.time), ctxFor(k.time));
    }
  }

  source.connect(gainNode).connect(panNode).connect(destination);
  const sourceOffset = inPoint + elapsed * speed;
  const remaining = dur - elapsed;
  try {
    source.start(whenStart, sourceOffset, remaining * speed);
  } catch {
    return null;
  }
  return source;
}

// ---------------------------------------------------------------------------
// Decode cache
// ---------------------------------------------------------------------------

const decodeCache = new Map<string, AudioBuffer>();

export async function decodeToBuffer(
  ctx: AnyAudioContext,
  mediaId: string,
  blob: Blob,
): Promise<AudioBuffer | null> {
  const cached = decodeCache.get(mediaId);
  if (cached) return cached;
  try {
    const arr = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    decodeCache.set(mediaId, buf);
    return buf;
  } catch {
    return null;
  }
}

export function clearDecodeCache(): void {
  decodeCache.clear();
}

// ---------------------------------------------------------------------------
// Offline mix (export)
// ---------------------------------------------------------------------------

export async function buildOfflineMix(
  p: Project,
  sampleRate: number,
  duration: number,
  getBlob: (mediaId: string) => Promise<Blob | undefined>,
): Promise<AudioBuffer | null> {
  const length = Math.ceil(duration * sampleRate);
  if (length <= 0) return null;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const sources = audioSources(p);
  let any = false;
  for (const src of sources) {
    const blob = await getBlob(src.mediaId);
    if (!blob) continue;
    const buf = await decodeToBuffer(ctx, src.mediaId, blob);
    if (!buf) continue;
    const node = scheduleClipAudio(ctx, ctx.destination, src, buf, {
      timeBaseCtx: 0,
      fromTime: 0,
      master: p.masterGain,
    });
    if (node) any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}

// ---------------------------------------------------------------------------
// Real-time preview mixer
// ---------------------------------------------------------------------------

export class PreviewMixer {
  private ctx: AudioContext | null = null;
  private active: AudioBufferSourceNode[] = [];
  private startCtxTime = 0;
  private fromTime = 0;
  playing = false;

  constructor(private getBlob: (mediaId: string) => Promise<Blob | undefined>) {}

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  /** Decode all of a project's audio sources so playback starts without gaps. */
  async prepare(p: Project): Promise<void> {
    const ctx = this.ensureCtx();
    const ids = new Set(audioSources(p).map((s) => s.mediaId));
    for (const id of ids) {
      if (decodeCache.has(id)) continue;
      const blob = await this.getBlob(id);
      if (blob) await decodeToBuffer(ctx, id, blob);
    }
  }

  async play(p: Project, fromTime: number): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
    this.stop();
    this.fromTime = fromTime;
    this.startCtxTime = ctx.currentTime + 0.06;
    this.playing = true;
    for (const src of audioSources(p)) {
      const buf = decodeCache.get(src.mediaId);
      if (!buf) continue;
      const node = scheduleClipAudio(ctx, ctx.destination, src, buf, {
        timeBaseCtx: this.startCtxTime,
        fromTime,
        master: p.masterGain,
      });
      if (node) this.active.push(node);
    }
  }

  stop(): void {
    for (const n of this.active) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active = [];
    this.playing = false;
  }

  /** Audio-locked timeline time while playing (eliminates wall-clock drift). */
  currentTime(): number {
    if (!this.ctx || !this.playing) return this.fromTime;
    return this.fromTime + (this.ctx.currentTime - this.startCtxTime);
  }

  hasAudible(p: Project): boolean {
    return audioSources(p).some((s) => decodeCache.has(s.mediaId));
  }
}
