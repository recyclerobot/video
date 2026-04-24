// Project / timeline data model.
export type ClipKind = "video" | "audio" | "title" | "effect";

export interface BaseClip {
  id: string;
  trackId: string;
  /** Position on timeline, seconds */
  start: number;
  /** Duration on timeline (after speed/trim), seconds */
  duration: number;
}

export interface VideoClip extends BaseClip {
  kind: "video";
  mediaId: string;
  /** in-point in source media (seconds) */
  inPoint: number;
  /** playback speed multiplier (1 = normal, 2 = 2x fast, 0.5 = slow) */
  speed: number;
  /** Use the clip's own audio? If false, audio is muted. */
  useOwnAudio: boolean;
  volume: number; // 0..1
}

export interface AudioClip extends BaseClip {
  kind: "audio";
  mediaId: string;
  inPoint: number;
  speed: number;
  volume: number; // 0..1
}

export interface TitleClip extends BaseClip {
  kind: "title";
  text: string;
  fontSize: number;
  color: string;
  bgColor: string; // "transparent" allowed
  x: number; // 0..1
  y: number; // 0..1
}

export interface EffectClip extends BaseClip {
  kind: "effect";
  /** brightness 0..2 (1 = neutral) */
  brightness: number;
  /** contrast 0..2 */
  contrast: number;
  /** saturation 0..2 */
  saturation: number;
  /** hue rotation in degrees */
  hue: number;
  /** tint color, mixed with output by `tintAmount` */
  tint: string;
  tintAmount: number; // 0..1
}

export type Clip = VideoClip | AudioClip | TitleClip | EffectClip;

export interface Track {
  id: string;
  name: string;
  kind: ClipKind;
  muted?: boolean;
  hidden?: boolean;
}

export interface MediaAsset {
  id: string;
  name: string;
  /** "video" or "audio" */
  type: "video" | "audio";
  /** ObjectURL for in-session playback (not persisted) */
  url?: string;
  /** Persisted blob in IndexedDB (referenced by id) */
  size: number;
  duration: number;
  thumbnail?: string; // dataURL
  width?: number;
  height?: number;
}

export interface Project {
  version: 1;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  clips: Clip[];
  media: MediaAsset[];
}

export const newId = (prefix = "id"): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;

export function defaultProject(): Project {
  return {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      { id: "t_effect", name: "Effects", kind: "effect" },
      { id: "t_title", name: "Titles", kind: "title" },
      { id: "t_v1", name: "Video 1", kind: "video" },
      { id: "t_v2", name: "Video 2", kind: "video" },
      { id: "t_a1", name: "Audio 1", kind: "audio" },
      { id: "t_a2", name: "Audio 2", kind: "audio" },
    ],
    clips: [],
    media: [],
  };
}
