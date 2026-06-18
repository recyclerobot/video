// Schema migrations. Old saved projects must keep loading as the model grows.
import {
  SCHEMA_VERSION,
  defaultTransform,
  defaultAudioProps,
  newId,
  makeColorGradeFilter,
  type Project,
  type Clip,
  type FilterInstance,
} from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Migrate an arbitrary stored object up to the current schema. */
export function migrate(raw: any): Project {
  if (!raw || typeof raw !== "object") throw new Error("invalid project");
  let v = raw.version ?? 1;
  let p = raw;
  if (v === 1) {
    p = migrateV1toV2(p);
    v = 2;
  }
  p.version = SCHEMA_VERSION;
  return normalize(p);
}

function migrateV1toV2(v1: any): any {
  const clips: any[] = (v1.clips ?? []).map((c: any) => {
    if (c.kind === "video") {
      return {
        kind: "video",
        id: c.id,
        trackId: c.trackId,
        start: c.start,
        duration: c.duration,
        mediaId: c.mediaId,
        inPoint: c.inPoint ?? 0,
        speed: c.speed ?? 1,
        useOwnAudio: c.useOwnAudio ?? true,
        transform: defaultTransform(),
        filters: [],
        audio: { ...defaultAudioProps(), volume: c.volume ?? 1 },
      };
    }
    if (c.kind === "audio") {
      return {
        kind: "audio",
        id: c.id,
        trackId: c.trackId,
        start: c.start,
        duration: c.duration,
        mediaId: c.mediaId,
        inPoint: c.inPoint ?? 0,
        speed: c.speed ?? 1,
        audio: { ...defaultAudioProps(), volume: c.volume ?? 1 },
      };
    }
    if (c.kind === "title") {
      const t = defaultTransform();
      t.x = (c.x ?? 0.5) * 2 - 1; // old 0..1 → -1..1 offset
      t.y = (c.y ?? 0.5) * 2 - 1;
      return {
        kind: "title",
        id: c.id,
        trackId: c.trackId,
        start: c.start,
        duration: c.duration,
        text: c.text ?? "",
        fontFamily: "system-ui",
        fontSize: c.fontSize ?? 64,
        fontWeight: 600,
        italic: false,
        color: c.color ?? "#ffffff",
        align: "center",
        lineHeight: 1.2,
        letterSpacing: 0,
        strokeColor: "#000000",
        strokeWidth: 0,
        shadow: { enabled: false, color: "#000000", blur: 6, x: 0, y: 2 },
        bgColor: c.bgColor ?? "transparent",
        bgPadding: 12,
        bgRadius: 0,
        animation: { preset: "none", inDuration: 0.4, outDuration: 0.4 },
        transform: t,
        filters: [],
      };
    }
    if (c.kind === "effect") {
      const grade: FilterInstance = makeColorGradeFilter();
      grade.params = {
        brightness: c.brightness ?? 1,
        contrast: c.contrast ?? 1,
        saturation: c.saturation ?? 1,
        hue: c.hue ?? 0,
        exposure: 0,
        temperature: 0,
        tint: c.tint ?? "#000000",
        tintAmount: c.tintAmount ?? 0,
      };
      return {
        kind: "effect",
        id: c.id,
        trackId: c.trackId,
        start: c.start,
        duration: c.duration,
        filters: [grade],
      };
    }
    return c;
  });

  return {
    version: 2,
    id: v1.id ?? newId("proj"),
    name: v1.name ?? "Untitled project",
    width: v1.width ?? 1280,
    height: v1.height ?? 720,
    fps: v1.fps ?? 30,
    masterGain: 1,
    tracks: (v1.tracks ?? []).map((t: any) =>
      t.kind === "audio" ? { gain: 1, pan: 0, ...t } : t,
    ),
    clips,
    transitions: [],
    media: v1.media ?? [],
    luts: [],
    markers: [],
    inPoint: null,
    outPoint: null,
  };
}

/** Backfill any fields missing on a current-version project. */
export function normalize(p: any): Project {
  p.id ??= newId("proj");
  p.name ??= "Untitled project";
  p.masterGain ??= 1;
  p.transitions ??= [];
  p.luts ??= [];
  p.markers ??= [];
  p.inPoint ??= null;
  p.outPoint ??= null;
  p.tracks ??= [];
  p.clips ??= [];
  p.media ??= [];
  for (const c of p.clips as Clip[]) {
    if (
      c.kind === "video" ||
      c.kind === "image" ||
      c.kind === "sequence" ||
      c.kind === "title"
    ) {
      (c as any).transform ??= defaultTransform();
      (c as any).filters ??= [];
    }
    if (c.kind === "video" || c.kind === "audio") {
      (c as any).audio ??= defaultAudioProps();
    }
    if (c.kind === "effect") (c as any).filters ??= [];
  }
  for (const t of p.tracks) {
    if (t.kind === "audio") {
      t.gain ??= 1;
      t.pan ??= 0;
    }
  }
  return p as Project;
}
