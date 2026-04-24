// Real-time playback engine.
// Drives video/audio elements based on the project's playhead and
// composites every frame with the WebGL compositor.
import type {
  Project,
  VideoClip,
  AudioClip,
  EffectClip,
  TitleClip,
} from "./types";
import {
  Compositor,
  combineEffects,
  NEUTRAL_COLOR,
  renderTitles,
} from "./webgl";
import { getMediaElement, disposeClipElement } from "./media";

export class PlaybackEngine {
  playing = false;
  time = 0; // seconds
  lastTickAt = 0;
  loopHandle = 0;
  onTime?: (t: number) => void;
  comp: Compositor;
  overlay: HTMLCanvasElement;
  overlayCtx: CanvasRenderingContext2D;

  constructor(
    public project: Project,
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
  ) {
    this.comp = new Compositor(canvas);
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext("2d")!;
    this.resize();
  }

  setProject(p: Project): void {
    this.project = p;
    this.resize();
  }

  resize(): void {
    const { width, height } = this.project;
    this.comp.resize(width, height);
    this.overlay.width = width;
    this.overlay.height = height;
  }

  duration(): number {
    let max = 0;
    for (const c of this.project.clips) {
      max = Math.max(max, c.start + c.duration);
    }
    return Math.max(max, 1);
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTickAt = performance.now();
    this.tick();
    this.syncMedia(true);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.loopHandle);
    this.pauseAllMedia();
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration(), t));
    this.syncMedia(this.playing);
    this.renderFrame();
    this.onTime?.(this.time);
  }

  private tick = (): void => {
    if (!this.playing) return;
    const now = performance.now();
    const dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    this.time += dt;
    if (this.time >= this.duration()) {
      this.time = this.duration();
      this.playing = false;
      this.pauseAllMedia();
    }
    this.renderFrame();
    this.onTime?.(this.time);
    if (this.playing) this.loopHandle = requestAnimationFrame(this.tick);
  };

  private async pauseAllMedia(): Promise<void> {
    for (const c of this.project.clips) {
      if (c.kind === "video" || c.kind === "audio") {
        try {
          const el = await getMediaElement(c);
          el.pause();
        } catch {
          /* element may not be loaded yet */
        }
      }
    }
  }

  /** Sync media element currentTime/playback rate/play state to the playhead. */
  async syncMedia(shouldPlay: boolean): Promise<void> {
    const t = this.time;
    for (const c of this.project.clips) {
      if (c.kind !== "video" && c.kind !== "audio") continue;
      const active = t >= c.start && t < c.start + c.duration;
      try {
        // Video clips reuse the cached <video> element used for rendering.
        const el: HTMLVideoElement | HTMLAudioElement | undefined =
          c.kind === "video"
            ? videoElCache.get(c.id)
            : await getMediaElement(c);
        if (!el) continue;
        if (active) {
          const localElapsed = t - c.start;
          const sourceTime = c.inPoint + localElapsed * c.speed;
          if (Math.abs(el.currentTime - sourceTime) > 0.15) {
            el.currentTime = sourceTime;
          }
          el.playbackRate = c.speed;
          if (c.kind === "video") {
            const v = c as VideoClip;
            el.muted = !v.useOwnAudio;
            el.volume = v.volume;
          } else {
            el.volume = (c as AudioClip).volume;
          }
          if (shouldPlay && el.paused) {
            try {
              await el.play();
            } catch {
              /* user gesture */
            }
          } else if (!shouldPlay && !el.paused) {
            el.pause();
          }
        } else {
          if (!el.paused) el.pause();
        }
      } catch {
        /* media not yet loaded */
      }
    }
  }

  /** Render one frame to the WebGL canvas + overlay canvas. */
  renderFrame(): void {
    const t = this.time;
    const p = this.project;

    // Order tracks bottom-to-top: bottom of array = back layer.
    // Internal convention: tracks ordered as project.tracks; we render in REVERSE
    // (last → first) so the FIRST track in the project is the topmost layer.
    const renderOrder = [...p.tracks].reverse();
    this.comp.clear();

    // Determine active effect clips (these apply to layers BELOW their track).
    const trackIndex = new Map<string, number>();
    p.tracks.forEach((tr, i) => trackIndex.set(tr.id, i));
    const effectsActive: EffectClip[] = p.clips
      .filter(
        (c): c is EffectClip =>
          c.kind === "effect" && t >= c.start && t < c.start + c.duration,
      )
      .filter((c) => {
        const tr = p.tracks.find((x) => x.id === c.trackId);
        return tr ? !tr.hidden : true;
      });

    for (const tr of renderOrder) {
      if (tr.hidden) continue;
      if (tr.kind !== "video") continue;
      const trIdx = trackIndex.get(tr.id) ?? 0;
      // Effects whose track index is LESS than this video track's index
      // are "above" — they apply to layers below them.
      const applicableEffects = effectsActive.filter((e) => {
        const eIdx = trackIndex.get(e.trackId) ?? 0;
        return eIdx < trIdx;
      });
      const color = applicableEffects.length
        ? combineEffects(applicableEffects)
        : { ...NEUTRAL_COLOR };

      const clip = p.clips.find(
        (c) =>
          c.trackId === tr.id &&
          c.kind === "video" &&
          t >= c.start &&
          t < c.start + c.duration,
      ) as VideoClip | undefined;
      if (!clip) continue;
      // Frame source comes from the videoElCache populated by main.ts after preload.
      const v = videoElCache.get(clip.id);
      if (v && v.readyState >= 2) {
        const tex = this.comp.uploadFrame(`clip:${clip.id}`, v);
        this.comp.drawTexture(tex, color);
      }
    }

    // Overlay (titles) — clear, then draw.
    this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const titles = p.clips.filter(
      (c): c is TitleClip =>
        c.kind === "title" && t >= c.start && t < c.start + c.duration,
    );
    if (titles.length)
      renderTitles(
        this.overlayCtx,
        this.overlay.width,
        this.overlay.height,
        titles,
      );
  }

  disposeClip(clipId: string): void {
    disposeClipElement(clipId);
    this.comp.disposeTex(`clip:${clipId}`);
    videoElCache.delete(clipId);
  }
}

// Side cache of loaded HTMLVideoElement keyed by clip id, populated by main.ts.
export const videoElCache = new Map<string, HTMLVideoElement>();
