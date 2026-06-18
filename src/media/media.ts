// Media probing + a per-clip HTMLMediaElement pool for preview seeking.
import type { VideoClip } from "../types";
import { getBlob } from "../storage";

const objectUrls = new Map<string, string>();
const videoPool = new Map<string, HTMLVideoElement>(); // clipId -> element

export async function urlForMedia(mediaId: string): Promise<string> {
  const cached = objectUrls.get(mediaId);
  if (cached) return cached;
  const blob = await getBlob(mediaId);
  if (!blob) throw new Error(`Media ${mediaId} not found`);
  const url = URL.createObjectURL(blob);
  objectUrls.set(mediaId, url);
  return url;
}

export function revokeMediaUrl(mediaId: string): void {
  const u = objectUrls.get(mediaId);
  if (u) {
    URL.revokeObjectURL(u);
    objectUrls.delete(mediaId);
  }
}

/** Get (and lazily create) a <video> element for a video clip, muted for preview. */
export async function getVideoElement(clip: VideoClip): Promise<HTMLVideoElement> {
  let el = videoPool.get(clip.id);
  if (el) return el;
  const url = await urlForMedia(clip.mediaId);
  el = document.createElement("video");
  el.src = url;
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  el.muted = true; // audio routed through the Web Audio mixer
  el.playsInline = true;
  videoPool.set(clip.id, el);
  await new Promise<void>((resolve) => {
    if (el!.readyState >= 2) resolve();
    else el!.addEventListener("loadeddata", () => resolve(), { once: true });
  });
  return el;
}

export function peekVideoElement(clipId: string): HTMLVideoElement | undefined {
  return videoPool.get(clipId);
}

export function disposeVideoElement(clipId: string): void {
  const el = videoPool.get(clipId);
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
    videoPool.delete(clipId);
  }
}

export function disposeAllVideo(): void {
  for (const id of [...videoPool.keys()]) disposeVideoElement(id);
}

export interface ProbeResult {
  type: "video" | "audio" | "image";
  duration: number;
  width?: number;
  height?: number;
  thumbnail?: string;
}

/** Probe a media File for duration / dimensions / thumbnail. */
export async function probeMedia(file: File): Promise<ProbeResult> {
  if (file.type.startsWith("image/")) return probeImage(file);
  if (file.type.startsWith("audio/")) return probeAudio(file);
  return probeVideo(file);
}

async function probeVideo(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise<void>((res, rej) => {
      v.addEventListener("loadeddata", () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("video probe failed")), {
        once: true,
      });
    });
    const seekTo = Math.min(0.3, (v.duration || 1) / 4);
    await new Promise<void>((res) => {
      v.addEventListener("seeked", () => res(), { once: true });
      v.currentTime = seekTo;
    });
    return {
      type: "video",
      duration: v.duration || 0,
      width: v.videoWidth,
      height: v.videoHeight,
      thumbnail: thumbFrom(v, v.videoWidth, v.videoHeight),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeAudio(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement("audio");
    a.src = url;
    a.preload = "auto";
    await new Promise<void>((res, rej) => {
      a.addEventListener("loadedmetadata", () => res(), { once: true });
      a.addEventListener("error", () => rej(new Error("audio probe failed")), {
        once: true,
      });
    });
    return { type: "audio", duration: a.duration || 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function probeImage(file: File | Blob): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      type: "image",
      duration: 0,
      width: img.naturalWidth,
      height: img.naturalHeight,
      thumbnail: thumbFrom(img, img.naturalWidth, img.naturalHeight),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function thumbFrom(
  src: CanvasImageSource,
  sw: number,
  sh: number,
): string | undefined {
  try {
    const w = 96;
    const h = Math.max(1, Math.round((sh / sw) * w));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(src, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}
