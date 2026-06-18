// ============================================================================
// Project / timeline data model (schema v2).
//
// v2 adds, on top of v1:
//  - image + image-sequence media/clips
//  - per-clip transform (position/scale/rotation/opacity/crop)
//  - keyframes / animated properties on numeric fields
//  - per-clip filter stacks (replacing the single global color grade)
//  - transitions between adjacent clips
//  - rich audio (fades, pan, volume automation) + track gain/pan/solo
//  - rich text styling on titles
//
// Migrations from v1 live in state/migrations.ts.
// ============================================================================

export const SCHEMA_VERSION = 2 as const;

export type ClipKind =
  | "video"
  | "audio"
  | "title"
  | "effect"
  | "image"
  | "sequence";

// ---------------------------------------------------------------------------
// Keyframes / animated properties
// ---------------------------------------------------------------------------

export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export interface Keyframe {
  /** Time relative to the clip's start, in seconds. */
  time: number;
  value: number;
  /** Easing applied on the segment leaving this keyframe. */
  easing: Easing;
}

/**
 * A numeric property that is either a constant or a list of keyframes.
 * Use `sampleAt()` (engine/keyframes.ts) to evaluate at a local time.
 */
export type Animatable = number | { keys: Keyframe[] };

// ---------------------------------------------------------------------------
// Transform (visual clips)
// ---------------------------------------------------------------------------

export type FitMode = "contain" | "cover" | "stretch";

export interface Transform {
  /** Normalized horizontal offset (-1..1, fraction of frame width; 0 = centered). */
  x: Animatable;
  /** Normalized vertical offset (-1..1). */
  y: Animatable;
  /** Uniform scale multiplier (1 = fit per `fit`). */
  scale: Animatable;
  /** Rotation in degrees. */
  rotation: Animatable;
  /** 0..1 */
  opacity: Animatable;
  /** Crop fractions removed from each edge (0..1). */
  crop: { top: number; right: number; bottom: number; left: number };
  fit: FitMode;
}

export function defaultTransform(): Transform {
  return {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    fit: "contain",
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type FilterType =
  | "colorgrade"
  | "blur"
  | "sharpen"
  | "vignette"
  | "grain"
  | "pixelate"
  | "chromakey"
  | "lut";

/** Filter parameter values: animatable numbers, or static strings/booleans. */
export type FilterParam = Animatable | string | boolean;

export interface FilterInstance {
  id: string;
  type: FilterType;
  enabled: boolean;
  params: Record<string, FilterParam>;
}

// ---------------------------------------------------------------------------
// Audio properties (shared by video + audio clips)
// ---------------------------------------------------------------------------

export interface AudioProps {
  /** Linear gain 0..2, animatable (volume automation envelope). */
  volume: Animatable;
  /** Stereo pan -1 (L) .. 1 (R), animatable. */
  pan: Animatable;
  /** Fade-in length in seconds. */
  fadeIn: number;
  /** Fade-out length in seconds. */
  fadeOut: number;
}

export function defaultAudioProps(): AudioProps {
  return { volume: 1, pan: 0, fadeIn: 0, fadeOut: 0 };
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export interface BaseClip {
  id: string;
  trackId: string;
  /** Position on the timeline, seconds. */
  start: number;
  /** Duration on the timeline (after speed/trim), seconds. */
  duration: number;
}

/** Mixin for clips that are drawn to the canvas. */
export interface VisualProps {
  transform: Transform;
  filters: FilterInstance[];
}

export interface VideoClip extends BaseClip, VisualProps {
  kind: "video";
  mediaId: string;
  /** In-point in source media (seconds). */
  inPoint: number;
  /** Playback speed multiplier (1 = normal). */
  speed: number;
  /** Use the clip's own audio? */
  useOwnAudio: boolean;
  audio: AudioProps;
}

export interface ImageClip extends BaseClip, VisualProps {
  kind: "image";
  mediaId: string;
}

export interface SequenceClip extends BaseClip, VisualProps {
  kind: "sequence";
  mediaId: string;
  /** Frames-per-second to interpret the sequence at. */
  sourceFps: number;
  /** In-point as a source frame index. */
  inFrame: number;
  /** Playback speed multiplier. */
  speed: number;
  /** Hold the last frame instead of looping when the timeline outruns frames. */
  holdLast: boolean;
}

export interface AudioClip extends BaseClip {
  kind: "audio";
  mediaId: string;
  inPoint: number;
  speed: number;
  audio: AudioProps;
}

export type TextAlign = "left" | "center" | "right";

export interface TitleAnimation {
  /** Built-in entrance/exit preset. */
  preset: "none" | "fade" | "slide-up" | "slide-left" | "typewriter" | "pop";
  /** Entrance length, seconds. */
  inDuration: number;
  /** Exit length, seconds. */
  outDuration: number;
}

export interface TitleClip extends BaseClip, VisualProps {
  kind: "title";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: TextAlign;
  lineHeight: number;
  letterSpacing: number;
  strokeColor: string;
  strokeWidth: number;
  shadow: { enabled: boolean; color: string; blur: number; x: number; y: number };
  bgColor: string; // "transparent" allowed
  bgPadding: number;
  bgRadius: number;
  animation: TitleAnimation;
}

/** Adjustment layer: a filter stack applied to all visual layers below it. */
export interface EffectClip extends BaseClip {
  kind: "effect";
  filters: FilterInstance[];
}

export type Clip =
  | VideoClip
  | AudioClip
  | TitleClip
  | EffectClip
  | ImageClip
  | SequenceClip;

export type VisualClip = VideoClip | ImageClip | SequenceClip | TitleClip;

export function isVisual(c: Clip): c is VisualClip {
  return (
    c.kind === "video" ||
    c.kind === "image" ||
    c.kind === "sequence" ||
    c.kind === "title"
  );
}

export function hasMedia(
  c: Clip,
): c is VideoClip | AudioClip | ImageClip | SequenceClip {
  return (
    c.kind === "video" ||
    c.kind === "audio" ||
    c.kind === "image" ||
    c.kind === "sequence"
  );
}

export function hasAudio(c: Clip): c is VideoClip | AudioClip {
  return c.kind === "audio" || c.kind === "video";
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type TransitionType =
  | "crossfade"
  | "dip-black"
  | "dip-white"
  | "wipe"
  | "slide";

export interface Transition {
  id: string;
  trackId: string;
  /** Outgoing clip. */
  fromClipId: string;
  /** Incoming clip. */
  toClipId: string;
  type: TransitionType;
  /** Duration of the transition, seconds (centered on the cut). */
  duration: number;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export interface Track {
  id: string;
  name: string;
  kind: ClipKind;
  muted?: boolean;
  hidden?: boolean;
  /** Solo flag for audio monitoring. */
  solo?: boolean;
  /** Track-level linear gain (audio tracks), 0..2. */
  gain?: number;
  /** Track-level pan -1..1 (audio tracks). */
  pan?: number;
  /** Locked tracks reject edits. */
  locked?: boolean;
  /** Collapsed height for the timeline UI. */
  height?: number;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type MediaType = "video" | "audio" | "image" | "sequence";

export interface MediaAsset {
  id: string;
  name: string;
  type: MediaType;
  /** ObjectURL for in-session playback (not persisted). */
  url?: string;
  size: number;
  duration: number;
  thumbnail?: string; // dataURL
  width?: number;
  height?: number;
  /** Sequence-only: ordered list of per-frame blob ids in IndexedDB. */
  frameBlobIds?: string[];
  /** Sequence-only: assumed source fps. */
  fps?: number;
  /** Cached waveform peaks (downsampled), filled lazily for audio sources. */
  peaks?: number[];
}

// ---------------------------------------------------------------------------
// Imported color LUTs (.cube)
// ---------------------------------------------------------------------------

export interface LutAsset {
  id: string;
  name: string;
  /** Cube size N (NxNxN). */
  size: number;
  /** Flattened RGB float data, length = size^3 * 3. */
  data: number[];
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export interface Marker {
  id: string;
  time: number;
  label: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  version: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Master output gain 0..2. */
  masterGain: number;
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  media: MediaAsset[];
  luts: LutAsset[];
  markers: Marker[];
  /** In/out range for range export (seconds); null = whole timeline. */
  inPoint?: number | null;
  outPoint?: number | null;
}

export const newId = (prefix = "id"): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;

export function defaultProject(): Project {
  return {
    version: SCHEMA_VERSION,
    id: newId("proj"),
    name: "Untitled project",
    width: 1280,
    height: 720,
    fps: 30,
    masterGain: 1,
    tracks: [
      { id: "t_effect", name: "Adjustments", kind: "effect" },
      { id: "t_title", name: "Titles", kind: "title" },
      { id: "t_v1", name: "Video 1", kind: "video" },
      { id: "t_v2", name: "Video 2", kind: "video" },
      { id: "t_a1", name: "Audio 1", kind: "audio", gain: 1, pan: 0 },
      { id: "t_a2", name: "Audio 2", kind: "audio", gain: 1, pan: 0 },
    ],
    clips: [],
    transitions: [],
    media: [],
    luts: [],
    markers: [],
    inPoint: null,
    outPoint: null,
  };
}

// ---------------------------------------------------------------------------
// Clip factories
// ---------------------------------------------------------------------------

export function makeColorGradeFilter(): FilterInstance {
  return {
    id: newId("flt"),
    type: "colorgrade",
    enabled: true,
    params: {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hue: 0,
      exposure: 0,
      temperature: 0,
      tint: "#000000",
      tintAmount: 0,
    },
  };
}
