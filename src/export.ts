// MP4 (H.264 + AAC) export via WebCodecs + mp4-muxer.
// Uses the SAME render path as preview (engine/render.ts) so exports are WYSIWYG.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { Compositor } from "./engine/compositor";
import { renderProject, timelineDuration, type FrameProvider, type SourceFrame } from "./engine/render";
import { buildOfflineMix } from "./engine/audio";
import { renderTitleToCanvas } from "./engine/text";
import { SequenceFrameCache, frameIndexFor } from "./media/sequence";
import { getBlob } from "./storage";
import type { Project, SequenceClip, TitleClip, VideoClip, VisualClip } from "./types";

export interface ExportOptions {
  width?: number;
  height?: number;
  fps?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  /** Export only [inSec, outSec]; defaults to whole timeline. */
  inSec?: number;
  outSec?: number;
  onProgress?: (frac: number, msg: string) => void;
  signal?: AbortSignal;
}

class ExportProvider implements FrameProvider {
  videoEls = new Map<string, HTMLVideoElement>(); // clipId -> element
  images = new Map<string, ImageBitmap>();
  seqCache = new SequenceFrameCache(120);
  constructor(private project: Project) {}

  getSource(clip: VisualClip, localTime: number): SourceFrame | null {
    if (clip.kind === "video") {
      const el = this.videoEls.get(clip.id);
      if (el && el.readyState >= 2) return { source: el, w: el.videoWidth, h: el.videoHeight };
      return null;
    }
    if (clip.kind === "image") {
      const bmp = this.images.get(clip.mediaId);
      return bmp ? { source: bmp, w: bmp.width, h: bmp.height } : null;
    }
    if (clip.kind === "sequence") {
      const seq = clip as SequenceClip;
      const m = this.project.media.find((x) => x.id === seq.mediaId);
      if (!m || !m.frameBlobIds) return null;
      const idx = frameIndexFor(localTime, seq.inFrame, seq.speed, seq.sourceFps, m.frameBlobIds.length, seq.holdLast);
      const bmp = this.seqCache.peek(m, idx);
      return bmp ? { source: bmp, w: bmp.width, h: bmp.height } : null;
    }
    if (clip.kind === "title") {
      const cv = renderTitleToCanvas(clip as TitleClip, this.project.width, this.project.height, localTime);
      return { source: cv, w: this.project.width, h: this.project.height };
    }
    return null;
  }
}

export async function exportMp4(p: Project, opts: ExportOptions = {}): Promise<Blob> {
  if (typeof VideoEncoder === "undefined")
    throw new Error("WebCodecs VideoEncoder not available in this browser.");
  const onProgress = opts.onProgress ?? (() => {});
  const fps = opts.fps ?? p.fps;
  const W = opts.width ?? p.width;
  const H = opts.height ?? p.height;
  const startT = Math.max(0, opts.inSec ?? 0);
  const endT = Math.min(timelineDuration(p), opts.outSec ?? timelineDuration(p));
  const duration = Math.max(0.1, endT - startT);
  const totalFrames = Math.max(1, Math.ceil(duration * fps));

  // export-resolution project (transforms are normalized, so scaling is safe)
  const exp: Project = { ...p, width: W, height: H, fps };

  onProgress(0, "mixing audio…");
  const sampleRate = 48000;
  const fullMix = await buildOfflineMix(p, sampleRate, timelineDuration(p), getBlob);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    audio: fullMix ? { codec: "aac", numberOfChannels: 2, sampleRate } : undefined,
    fastStart: "in-memory",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error("VideoEncoder error", e),
  });
  let configured = false;
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42E01F"]) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: W,
        height: H,
        bitrate: opts.videoBitrate ?? 8_000_000,
        framerate: fps,
        avc: { format: "avc" },
      });
      if (support.supported && support.config) {
        videoEncoder.configure(support.config);
        configured = true;
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!configured) throw new Error("No supported H.264 encoder configuration found.");

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const comp = new Compositor(canvas);
  comp.setSize(W, H);
  const provider = new ExportProvider(exp);

  // preload video elements (one per clip) + images
  onProgress(0, "loading sources…");
  for (const clip of p.clips) {
    if (clip.kind === "video") {
      const blob = await getBlob((clip as VideoClip).mediaId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video");
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      await new Promise<void>((res, rej) => {
        v.addEventListener("loadeddata", () => res(), { once: true });
        v.addEventListener("error", () => rej(new Error("source load")), { once: true });
      });
      provider.videoEls.set(clip.id, v);
    } else if (clip.kind === "image") {
      if (provider.images.has(clip.mediaId)) continue;
      const blob = await getBlob(clip.mediaId);
      if (blob) provider.images.set(clip.mediaId, await createImageBitmap(blob));
    }
  }

  for (let f = 0; f < totalFrames; f++) {
    if (opts.signal?.aborted) {
      videoEncoder.close();
      throw new Error("Export cancelled");
    }
    const t = startT + f / fps;
    onProgress(0.05 + 0.85 * (f / totalFrames), `encoding frame ${f + 1}/${totalFrames}`);

    // ensure active sources are ready at this time
    for (const c of p.clips) {
      if (c.start > t || c.start + c.duration <= t) continue;
      if (c.kind === "video") {
        const el = provider.videoEls.get(c.id);
        if (el) await seekVideoExact(el, c.inPoint + (t - c.start) * c.speed);
      } else if (c.kind === "sequence") {
        const seq = c as SequenceClip;
        const m = p.media.find((x) => x.id === seq.mediaId);
        if (m && m.frameBlobIds) {
          const idx = frameIndexFor(t - c.start, seq.inFrame, seq.speed, seq.sourceFps, m.frameBlobIds.length, seq.holdLast);
          await provider.seqCache.load(m, idx);
        }
      }
    }

    renderProject(comp, exp, t, provider);

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((f / fps) * 1_000_000),
      duration: Math.round(1_000_000 / fps),
    });
    videoEncoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();
    while (videoEncoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
    if (f % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await videoEncoder.flush();
  videoEncoder.close();

  if (fullMix) {
    onProgress(0.92, "encoding audio…");
    await encodeAudio(muxer, fullMix, sampleRate, startT, duration, opts.audioBitrate ?? 160_000);
  }

  onProgress(0.98, "finalizing…");
  muxer.finalize();
  const { buffer } = muxer.target as ArrayBufferTarget;
  for (const v of provider.videoEls.values()) URL.revokeObjectURL(v.src);
  provider.seqCache.clear();
  onProgress(1, "done");
  return new Blob([buffer], { type: "video/mp4" });
}

async function encodeAudio(
  muxer: Muxer<ArrayBufferTarget>,
  buffer: AudioBuffer,
  sampleRate: number,
  startT: number,
  duration: number,
  bitrate: number,
): Promise<void> {
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error("AudioEncoder error", e),
  });
  audioEncoder.configure({ codec: "mp4a.40.2", sampleRate, numberOfChannels: 2, bitrate });
  const startSample = Math.floor(startT * sampleRate);
  const endSample = Math.min(buffer.length, startSample + Math.ceil(duration * sampleRate));
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const chunk = 1024;
  let pos = startSample;
  let outTs = 0;
  while (pos < endSample) {
    const n = Math.min(chunk, endSample - pos);
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i * 2] = left[pos + i];
      data[i * 2 + 1] = right[pos + i];
    }
    const ad = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((outTs / sampleRate) * 1_000_000),
      data,
    });
    audioEncoder.encode(ad);
    ad.close();
    pos += n;
    outTs += n;
  }
  await audioEncoder.flush();
  audioEncoder.close();
}

function seekVideoExact(el: HTMLVideoElement, t: number): Promise<void> {
  const dur = el.duration || 0;
  const target = Math.max(0, Math.min(dur > 0 ? dur - 0.001 : t, t));
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (Math.abs(el.currentTime - target) < 1 / 240) {
      finish();
      return;
    }
    const onSeek = () => {
      el.removeEventListener("seeked", onSeek);
      finish();
    };
    el.addEventListener("seeked", onSeek);
    setTimeout(() => {
      el.removeEventListener("seeked", onSeek);
      finish();
    }, 1500);
    try {
      el.currentTime = target;
    } catch {
      finish();
    }
  });
}

/** Parse a .cube LUT file into the LutAsset shape. */
export function parseCube(text: string): { size: number; data: number[] } {
  let size = 0;
  const data: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (/^TITLE|^DOMAIN_|^LUT_1D/.test(line)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((n) => !isNaN(n))) data.push(parts[0], parts[1], parts[2]);
  }
  if (size === 0 || data.length !== size * size * size * 3)
    throw new Error("Unsupported or invalid .cube LUT");
  return { size, data };
}
