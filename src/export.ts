// MP4 H.264 export using WebCodecs + mp4-muxer.
// Renders the timeline frame-by-frame offscreen and encodes via VideoEncoder.
// Audio is mixed via OfflineAudioContext (decoded with WebAudio) and encoded with AudioEncoder (AAC).
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
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
import { getBlob } from "./storage";

export interface ExportOptions {
  videoBitrate?: number;
  audioBitrate?: number;
  onProgress?: (frac: number, msg: string) => void;
}

export async function exportMp4(
  p: Project,
  opts: ExportOptions = {},
): Promise<Blob> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs VideoEncoder not available in this browser.");
  }
  const onProgress = opts.onProgress ?? (() => {});
  const fps = p.fps;
  const W = p.width;
  const H = p.height;
  const duration = timelineDuration(p);
  const totalFrames = Math.max(1, Math.ceil(duration * fps));

  // Mix audio first (it's quick and lets us know exact sample count).
  onProgress(0, "mixing audio…");
  const sampleRate = 48000;
  const audioBuffer = await mixAudio(p, sampleRate);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width: W,
      height: H,
      frameRate: fps,
    },
    audio: audioBuffer
      ? {
          codec: "aac",
          numberOfChannels: 2,
          sampleRate,
        }
      : undefined,
    fastStart: "in-memory",
  });

  // ---------- VIDEO ENCODER ----------
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error("VideoEncoder error", e),
  });
  // Try a few common AVC profiles; fall back through them.
  const codecsToTry = ["avc1.640028", "avc1.4d0028", "avc1.42E01F"];
  let configured = false;
  for (const codec of codecsToTry) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: W,
        height: H,
        bitrate: opts.videoBitrate ?? 5_000_000,
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
  if (!configured)
    throw new Error("No supported H.264 encoder configuration found.");

  // ---------- OFFSCREEN COMPOSITOR ----------
  const glCanvas = new OffscreenCanvas(W, H);
  // Compositor expects HTMLCanvasElement; we adapt by creating a real canvas.
  const realCanvas = document.createElement("canvas");
  realCanvas.width = W;
  realCanvas.height = H;
  const comp = new Compositor(realCanvas);
  const overlay = document.createElement("canvas");
  overlay.width = W;
  overlay.height = H;
  const overlayCtx = overlay.getContext("2d")!;
  // Final compositor onto an OffscreenCanvas (RGBA -> VideoFrame).
  const finalCanvas = new OffscreenCanvas(W, H);
  const finalCtx = finalCanvas.getContext("2d")!;
  void glCanvas; // reserved for future direct path

  // Pre-decode all video clips' source media into <video> elements (for seeking).
  onProgress(0, "loading video sources…");
  const videoEls = new Map<string, HTMLVideoElement>(); // mediaId -> el
  for (const clip of p.clips) {
    if (clip.kind !== "video") continue;
    if (videoEls.has(clip.mediaId)) continue;
    const blob = await getBlob(clip.mediaId);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise<void>((res, rej) => {
      v.addEventListener("loadeddata", () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("source load")), {
        once: true,
      });
    });
    videoEls.set(clip.mediaId, v);
  }

  // ---------- FRAME LOOP ----------
  const trackIndex = new Map<string, number>();
  p.tracks.forEach((tr, i) => trackIndex.set(tr.id, i));

  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps;
    onProgress(
      0.05 + 0.85 * (f / totalFrames),
      `encoding frame ${f + 1}/${totalFrames}`,
    );

    // Seek every active video clip to the right time.
    const activeVideos: { clip: VideoClip; el: HTMLVideoElement }[] = [];
    for (const c of p.clips) {
      if (c.kind !== "video") continue;
      if (t < c.start || t >= c.start + c.duration) continue;
      const el = videoEls.get(c.mediaId);
      if (!el) continue;
      const sourceTime = c.inPoint + (t - c.start) * c.speed;
      await seekVideoExact(el, sourceTime);
      activeVideos.push({ clip: c, el });
    }

    // Compose with WebGL.
    comp.clear();
    const effectsActive: EffectClip[] = p.clips.filter(
      (c): c is EffectClip =>
        c.kind === "effect" && t >= c.start && t < c.start + c.duration,
    );
    const renderOrder = [...p.tracks].reverse();
    for (const tr of renderOrder) {
      if (tr.kind !== "video" || tr.hidden) continue;
      const trIdx = trackIndex.get(tr.id) ?? 0;
      const applicable = effectsActive.filter(
        (e) => (trackIndex.get(e.trackId) ?? 0) < trIdx,
      );
      const color = applicable.length
        ? combineEffects(applicable)
        : { ...NEUTRAL_COLOR };
      const av = activeVideos.find((x) => x.clip.trackId === tr.id);
      if (!av) continue;
      const tex = comp.uploadFrame(`exp:${av.clip.id}`, av.el);
      comp.drawTexture(tex, color);
    }
    // Draw GL canvas to final, then overlay titles.
    finalCtx.clearRect(0, 0, W, H);
    finalCtx.drawImage(realCanvas, 0, 0, W, H);
    overlayCtx.clearRect(0, 0, W, H);
    const titles = p.clips.filter(
      (c): c is TitleClip =>
        c.kind === "title" && t >= c.start && t < c.start + c.duration,
    );
    if (titles.length) {
      renderTitles(overlayCtx, W, H, titles);
      finalCtx.drawImage(overlay, 0, 0);
    }

    const frame = new VideoFrame(finalCanvas, {
      timestamp: Math.round((f / fps) * 1_000_000),
      duration: Math.round(1_000_000 / fps),
    });
    const keyFrame = f % (fps * 2) === 0;
    videoEncoder.encode(frame, { keyFrame });
    frame.close();
    if (videoEncoder.encodeQueueSize > 8) {
      // Backpressure
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  await videoEncoder.flush();
  videoEncoder.close();

  // ---------- AUDIO ENCODER ----------
  if (audioBuffer) {
    onProgress(0.92, "encoding audio…");
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => console.error("AudioEncoder error", e),
    });
    audioEncoder.configure({
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: 2,
      bitrate: opts.audioBitrate ?? 128_000,
    });

    // Send audio in chunks of ~1024 frames.
    const chunkSize = 1024;
    const total = audioBuffer.length;
    const interleaved = new Float32Array(chunkSize * 2);
    const left = audioBuffer.getChannelData(0);
    const right =
      audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    let pos = 0;
    while (pos < total) {
      const n = Math.min(chunkSize, total - pos);
      for (let i = 0; i < n; i++) {
        interleaved[i * 2] = left[pos + i];
        interleaved[i * 2 + 1] = right[pos + i];
      }
      const data = new Float32Array(n * 2);
      data.set(interleaved.subarray(0, n * 2));
      const ad = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: Math.round((pos / sampleRate) * 1_000_000),
        data,
      });
      audioEncoder.encode(ad);
      ad.close();
      pos += n;
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }

  onProgress(0.98, "finalizing mp4…");
  muxer.finalize();
  const { buffer } = muxer.target as ArrayBufferTarget;
  // Cleanup
  for (const v of videoEls.values()) {
    URL.revokeObjectURL(v.src);
  }
  onProgress(1, "done");
  return new Blob([buffer], { type: "video/mp4" });
}

/** Seek a video element exactly and wait for the frame. */
function seekVideoExact(el: HTMLVideoElement, t: number): Promise<void> {
  const dur = el.duration || 0;
  const target = Math.max(0, Math.min(dur > 0 ? dur - 0.001 : t, t));
  return new Promise((resolve) => {
    const done = () => resolve();
    if (Math.abs(el.currentTime - target) < 1 / 240) {
      // Close enough — request a frame to ensure latest is decoded.
      // requestVideoFrameCallback is broadly available in modern browsers.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rvfc = (el as any).requestVideoFrameCallback;
      if (rvfc) rvfc.call(el, () => done());
      else done();
      return;
    }
    el.addEventListener("seeked", function onSeek() {
      el.removeEventListener("seeked", onSeek);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rvfc = (el as any).requestVideoFrameCallback;
      if (rvfc) rvfc.call(el, () => done());
      else done();
    });
    el.currentTime = target;
  });
}

function timelineDuration(p: Project): number {
  let max = 0;
  for (const c of p.clips) max = Math.max(max, c.start + c.duration);
  return Math.max(max, 0.1);
}

/** Mix all audio sources (clip audio + audio clips) into a single stereo AudioBuffer. */
async function mixAudio(
  p: Project,
  sampleRate: number,
): Promise<AudioBuffer | null> {
  const dur = timelineDuration(p);
  const length = Math.ceil(dur * sampleRate);
  if (length <= 0) return null;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate,
  });

  let any = false;
  // Decode each unique source once and keep the AudioBuffer.
  const decoded = new Map<string, AudioBuffer>();
  const decodeCtx = new (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext
  )();

  const sources = [
    ...p.clips
      .filter(
        (c): c is VideoClip =>
          c.kind === "video" && c.useOwnAudio && c.volume > 0,
      )
      .map((c) => ({ clip: c, mediaId: c.mediaId })),
    ...p.clips
      .filter((c): c is AudioClip => c.kind === "audio" && c.volume > 0)
      .map((c) => ({ clip: c, mediaId: c.mediaId })),
  ];

  for (const s of sources) {
    if (decoded.has(s.mediaId)) continue;
    const blob = await getBlob(s.mediaId);
    if (!blob) continue;
    try {
      const arr = await blob.arrayBuffer();
      const buf = await decodeCtx.decodeAudioData(arr.slice(0));
      decoded.set(s.mediaId, buf);
    } catch (e) {
      console.warn("audio decode failed", e);
    }
  }

  for (const s of sources) {
    const buf = decoded.get(s.mediaId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (s.clip as VideoClip | AudioClip).speed;
    const gain = ctx.createGain();
    gain.gain.value = (s.clip as VideoClip | AudioClip).volume;
    src.connect(gain).connect(ctx.destination);
    src.start(
      s.clip.start,
      (s.clip as VideoClip | AudioClip).inPoint,
      s.clip.duration * (s.clip as VideoClip | AudioClip).speed,
    );
    any = true;
  }
  decodeCtx.close();
  if (!any) return null;
  return await ctx.startRendering();
}
