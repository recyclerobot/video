// Real-time preview engine. Drives the audio-locked clock, keeps video
// elements seeked, and renders each frame through the shared render path.
import { Compositor } from "./compositor";
import { renderProject, timelineDuration, type FrameProvider, type SourceFrame } from "./render";
import { PreviewMixer } from "./audio";
import { renderTitleToCanvas } from "./text";
import { SequenceFrameCache, frameIndexFor } from "../media/sequence";
import {
  getVideoElement,
  peekVideoElement,
  disposeVideoElement,
  disposeAllVideo,
} from "../media/media";
import { getBlob } from "../storage";
import type {
  ImageClip,
  MediaAsset,
  Project,
  SequenceClip,
  TitleClip,
  VideoClip,
  VisualClip,
} from "../types";

export class PlaybackEngine implements FrameProvider {
  playing = false;
  time = 0;
  onTime?: (t: number) => void;
  onEnded?: () => void;
  comp: Compositor;
  mixer: PreviewMixer;
  seqCache = new SequenceFrameCache(80);
  private images = new Map<string, ImageBitmap>();
  private loopHandle = 0;
  private mediaById = new Map<string, MediaAsset>();

  constructor(
    public project: Project,
    canvas: HTMLCanvasElement,
  ) {
    this.comp = new Compositor(canvas);
    this.comp.setSize(project.width, project.height);
    this.mixer = new PreviewMixer((id) => getBlob(id));
    this.indexMedia();
  }

  setProject(p: Project): void {
    this.project = p;
    this.indexMedia();
    this.comp.setSize(p.width, p.height);
  }
  private indexMedia(): void {
    this.mediaById = new Map(this.project.media.map((m) => [m.id, m]));
  }

  duration(): number {
    return Math.max(timelineDuration(this.project), 1);
  }

  // ---- preloading ----
  async preloadAll(): Promise<void> {
    for (const c of this.project.clips) await this.preloadClip(c);
  }
  async preloadClip(c: VisualClip | { kind: string }): Promise<void> {
    if ((c as VisualClip).kind === "video") {
      try {
        await getVideoElement(c as VideoClip);
        this.renderFrame();
      } catch {
        /* missing media */
      }
    } else if ((c as VisualClip).kind === "image") {
      await this.loadImage((c as ImageClip).mediaId);
      this.renderFrame();
    } else if ((c as VisualClip).kind === "sequence") {
      const seq = c as SequenceClip;
      const m = this.mediaById.get(seq.mediaId);
      if (m) {
        await this.seqCache.load(m, seq.inFrame);
        this.renderFrame();
      }
    }
  }
  private async loadImage(mediaId: string): Promise<ImageBitmap | null> {
    const cached = this.images.get(mediaId);
    if (cached) return cached;
    const blob = await getBlob(mediaId);
    if (!blob) return null;
    try {
      const bmp = await createImageBitmap(blob);
      this.images.set(mediaId, bmp);
      return bmp;
    } catch {
      return null;
    }
  }

  // ---- transport ----
  async play(): Promise<void> {
    if (this.playing) return;
    if (this.time >= this.duration()) this.time = 0;
    this.playing = true;
    await this.mixer.prepare(this.project);
    await this.mixer.play(this.project, this.time);
    void this.syncVideo(true);
    this.lastWall = performance.now();
    this.startTime = this.time;
    this.tick();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.loopHandle);
    this.mixer.stop();
    void this.pauseAllVideo();
  }

  private startTime = 0;
  private lastWall = 0;

  private tick = (): void => {
    if (!this.playing) return;
    // Audio-locked clock (falls back to elapsed wall time if needed).
    this.time = this.mixer.currentTime();
    if (this.time >= this.duration()) {
      this.time = this.duration();
      this.playing = false;
      this.mixer.stop();
      void this.pauseAllVideo();
      this.renderFrame();
      this.onTime?.(this.time);
      this.onEnded?.();
      return;
    }
    void this.syncVideo(true);
    this.renderFrame();
    this.onTime?.(this.time);
    this.loopHandle = requestAnimationFrame(this.tick);
  };

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration(), t));
    if (this.playing) {
      void this.mixer.play(this.project, this.time);
    }
    void this.syncVideo(this.playing).then(() => this.renderFrame());
    this.renderFrame();
    this.onTime?.(this.time);
  }

  // ---- video element sync ----
  private async syncVideo(shouldPlay: boolean): Promise<void> {
    const t = this.time;
    for (const c of this.project.clips) {
      if (c.kind !== "video") continue;
      const on = t >= c.start && t < c.start + c.duration;
      try {
        const el = on ? await getVideoElement(c) : peekVideoElement(c.id);
        if (!el) continue;
        if (on) {
          const srcTime = c.inPoint + (t - c.start) * c.speed;
          if (Math.abs(el.currentTime - srcTime) > 0.18) el.currentTime = srcTime;
          el.playbackRate = c.speed;
          if (shouldPlay && el.paused) el.play().catch(() => {});
          else if (!shouldPlay && !el.paused) el.pause();
        } else if (!el.paused) {
          el.pause();
        }
      } catch {
        /* not loaded */
      }
    }
  }
  private async pauseAllVideo(): Promise<void> {
    for (const c of this.project.clips) {
      if (c.kind === "video") {
        const el = peekVideoElement(c.id);
        if (el && !el.paused) el.pause();
      }
    }
  }

  // ---- FrameProvider ----
  getSource(clip: VisualClip, localTime: number): SourceFrame | null {
    if (clip.kind === "video") {
      const el = peekVideoElement(clip.id);
      if (el && el.readyState >= 2)
        return { source: el, w: el.videoWidth || 1, h: el.videoHeight || 1 };
      return null;
    }
    if (clip.kind === "image") {
      const bmp = this.images.get(clip.mediaId);
      if (bmp) return { source: bmp, w: bmp.width, h: bmp.height };
      void this.loadImage(clip.mediaId).then(() => this.renderFrame());
      return null;
    }
    if (clip.kind === "sequence") {
      const seq = clip as SequenceClip;
      const m = this.mediaById.get(seq.mediaId);
      if (!m || !m.frameBlobIds) return null;
      const idx = frameIndexFor(
        localTime,
        seq.inFrame,
        seq.speed,
        seq.sourceFps,
        m.frameBlobIds.length,
        seq.holdLast,
      );
      const bmp = this.seqCache.peek(m, idx);
      this.seqCache.prefetch(m, idx, 3);
      if (bmp) return { source: bmp, w: bmp.width, h: bmp.height };
      void this.seqCache.load(m, idx).then(() => this.renderFrame());
      return null;
    }
    if (clip.kind === "title") {
      const cv = renderTitleToCanvas(
        clip as TitleClip,
        this.project.width,
        this.project.height,
        localTime,
      );
      return { source: cv, w: this.project.width, h: this.project.height };
    }
    return null;
  }

  renderFrame(): void {
    renderProject(this.comp, this.project, this.time, this);
  }

  disposeClip(clipId: string): void {
    disposeVideoElement(clipId);
    this.comp.disposeSource(`clip:${clipId}`);
  }

  dispose(): void {
    this.pause();
    disposeAllVideo();
    this.seqCache.clear();
    for (const b of this.images.values()) b.close();
    this.images.clear();
  }
}
