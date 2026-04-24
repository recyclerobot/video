// Per-clip HTMLVideoElement / HTMLAudioElement pool for preview playback.
import type { Clip, VideoClip, AudioClip } from "./types";
import { getBlob } from "./storage";

interface Entry {
  el: HTMLVideoElement | HTMLAudioElement;
  url: string;
  ready: boolean;
}

const pool = new Map<string, Entry>();
const objectUrls = new Map<string, string>();

export async function urlForMedia(mediaId: string): Promise<string> {
  const cached = objectUrls.get(mediaId);
  if (cached) return cached;
  const blob = await getBlob(mediaId);
  if (!blob) throw new Error(`Media ${mediaId} not found`);
  const url = URL.createObjectURL(blob);
  objectUrls.set(mediaId, url);
  return url;
}

export async function getMediaElement(
  clip: VideoClip | AudioClip,
): Promise<HTMLVideoElement | HTMLAudioElement> {
  const key = `${clip.kind}:${clip.id}`;
  let entry = pool.get(key);
  if (entry) return entry.el;

  const url = await urlForMedia(clip.mediaId);
  const el =
    clip.kind === "video"
      ? document.createElement("video")
      : document.createElement("audio");
  el.src = url;
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  el.muted = clip.kind === "video"; // video muted (audio routed separately if needed)
  if (el instanceof HTMLVideoElement) {
    el.playsInline = true;
  }

  entry = { el, url, ready: false };
  pool.set(key, entry);

  await new Promise<void>((resolve) => {
    const done = () => {
      entry!.ready = true;
      resolve();
    };
    if (el.readyState >= 2) done();
    else el.addEventListener("loadeddata", done, { once: true });
  });
  return el;
}

export function disposeClipElement(clipId: string): void {
  for (const k of ["video:" + clipId, "audio:" + clipId]) {
    const e = pool.get(k);
    if (e) {
      e.el.pause();
      e.el.removeAttribute("src");
      e.el.load();
      pool.delete(k);
    }
  }
}

export function disposeAll(): void {
  for (const [, e] of pool) {
    e.el.pause();
    e.el.removeAttribute("src");
    e.el.load();
  }
  pool.clear();
}

/** Probe a media File to extract duration / thumbnail / dimensions */
export async function probeMedia(
  file: File,
): Promise<{
  duration: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  type: "video" | "audio";
}> {
  const isVideo = file.type.startsWith("video/");
  const url = URL.createObjectURL(file);
  try {
    if (isVideo) {
      const v = document.createElement("video");
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      await new Promise<void>((res, rej) => {
        v.addEventListener("loadeddata", () => res(), { once: true });
        v.addEventListener(
          "error",
          () => rej(new Error("video probe failed")),
          { once: true },
        );
      });
      // seek a small offset for a meaningful frame
      const seekTo = Math.min(0.3, (v.duration || 1) / 4);
      await new Promise<void>((res) => {
        v.addEventListener("seeked", () => res(), { once: true });
        v.currentTime = seekTo;
      });
      const w = 96,
        h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(v, 0, 0, w, h);
      const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
      const out = {
        duration: v.duration || 0,
        width: v.videoWidth,
        height: v.videoHeight,
        thumbnail,
        type: "video" as const,
      };
      return out;
    } else {
      const a = document.createElement("audio");
      a.src = url;
      a.preload = "auto";
      await new Promise<void>((res, rej) => {
        a.addEventListener("loadedmetadata", () => res(), { once: true });
        a.addEventListener(
          "error",
          () => rej(new Error("audio probe failed")),
          { once: true },
        );
      });
      return { duration: a.duration || 0, type: "audio" };
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
