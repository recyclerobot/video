// High-level, undoable editing operations. UI calls these; live drag/trim use
// store transactions directly (see ui/timeline.ts).
import type { EditorStore } from "./store";
import {
  newId,
  type Clip,
  type Project,
  type TransitionType,
  type VideoClip,
  type AudioClip,
  type SequenceClip,
} from "../types";

function clip(p: Project, id: string): Clip | undefined {
  return p.clips.find((c) => c.id === id);
}

/** Split one clip at absolute timeline time `t`. Returns the new (right) clip id or null. */
export function splitClip(
  store: EditorStore,
  clipId: string,
  t: number,
): string | null {
  let newRightId: string | null = null;
  store.update("Split clip", (p) => {
    const c = clip(p, clipId);
    if (!c) return;
    if (t <= c.start + 0.001 || t >= c.start + c.duration - 0.001) return;
    const offset = t - c.start;
    const right: Clip = structuredClone(c);
    right.id = newId("c");
    right.start = t;
    right.duration = c.duration - offset;
    if (right.kind === "video" || right.kind === "audio") {
      right.inPoint =
        (c as VideoClip | AudioClip).inPoint +
        offset * (c as VideoClip | AudioClip).speed;
    } else if (right.kind === "sequence") {
      const seq = c as SequenceClip;
      right.inFrame = Math.round(
        seq.inFrame + offset * seq.speed * seq.sourceFps,
      );
    }
    c.duration = offset;
    p.clips.push(right);
    newRightId = right.id;
  });
  return newRightId;
}

/** Split every clip that the playhead intersects. */
export function splitAtPlayhead(store: EditorStore, t: number): void {
  const p = store.getProject();
  const targets = p.clips
    .filter((c) => t > c.start + 0.001 && t < c.start + c.duration - 0.001)
    .map((c) => c.id);
  for (const id of targets) splitClip(store, id, t);
}

/** Remove clips. ripple=true closes the gap on each affected track. */
export function removeClips(
  store: EditorStore,
  ids: string[],
  ripple = false,
): void {
  if (ids.length === 0) return;
  store.update(ripple ? "Ripple delete" : "Delete", (p) => {
    const removed = p.clips.filter((c) => ids.includes(c.id));
    p.clips = p.clips.filter((c) => !ids.includes(c.id));
    p.transitions = p.transitions.filter(
      (tr) => !ids.includes(tr.fromClipId) && !ids.includes(tr.toClipId),
    );
    if (ripple) {
      // Per track, shift later clips left by each removed clip's duration.
      for (const r of removed) {
        const after = p.clips.filter(
          (c) => c.trackId === r.trackId && c.start >= r.start,
        );
        for (const c of after) c.start = Math.max(0, c.start - r.duration);
      }
    }
  });
}

export function copySelection(store: EditorStore): void {
  const clips = store.selectedClips();
  if (clips.length === 0) return;
  const anchor = Math.min(...clips.map((c) => c.start));
  store.ui.clipboard = { clips: structuredClone(clips), anchor };
  store.setStatus(`copied ${clips.length} clip(s)`);
}

export function cutSelection(store: EditorStore): void {
  copySelection(store);
  removeClips(store, store.ui.selectedClipIds);
}

/** Paste clipboard clips so the earliest lands at `t`. */
export function pasteClipboard(store: EditorStore, t: number): void {
  const cb = store.ui.clipboard;
  if (!cb) return;
  const newIds: string[] = [];
  store.update("Paste", (p) => {
    for (const src of cb.clips) {
      const copy: Clip = structuredClone(src);
      copy.id = newId("c");
      copy.start = t + (src.start - cb.anchor);
      // Keep on the same track if it still exists, else first matching kind.
      if (!p.tracks.some((tr) => tr.id === copy.trackId)) {
        const tr = p.tracks.find((x) => x.kind === trackKindFor(copy));
        if (tr) copy.trackId = tr.id;
      }
      p.clips.push(copy);
      newIds.push(copy.id);
    }
  });
  store.setSelection(newIds);
}

export function duplicateSelection(store: EditorStore): void {
  const clips = store.selectedClips();
  if (clips.length === 0) return;
  const newIds: string[] = [];
  store.update("Duplicate", (p) => {
    for (const src of clips) {
      const copy: Clip = structuredClone(src);
      copy.id = newId("c");
      copy.start = src.start + src.duration; // drop immediately after
      p.clips.push(copy);
      newIds.push(copy.id);
    }
  });
  store.setSelection(newIds);
}

function trackKindFor(c: Clip): string {
  return c.kind;
}

/** Nudge selected clips by `dt` seconds (clamped at 0). */
export function nudgeSelection(store: EditorStore, dt: number): void {
  const ids = store.ui.selectedClipIds;
  if (ids.length === 0) return;
  store.update("Nudge", (p) => {
    for (const c of p.clips)
      if (ids.includes(c.id)) c.start = Math.max(0, c.start + dt);
  });
}

export function addTransition(
  store: EditorStore,
  fromClipId: string,
  toClipId: string,
  type: TransitionType,
  duration = 0.5,
): void {
  store.update("Add transition", (p) => {
    const from = clip(p, fromClipId);
    const to = clip(p, toClipId);
    if (!from || !to || from.trackId !== to.trackId) return;
    // Remove an existing transition on the same boundary.
    p.transitions = p.transitions.filter(
      (tr) => !(tr.fromClipId === fromClipId && tr.toClipId === toClipId),
    );
    p.transitions.push({
      id: newId("tr"),
      trackId: from.trackId,
      fromClipId,
      toClipId,
      type,
      duration,
    });
  });
}

export function removeTransition(store: EditorStore, id: string): void {
  store.update("Remove transition", (p) => {
    p.transitions = p.transitions.filter((tr) => tr.id !== id);
  });
}

/** Extract a video clip's audio into a new audio clip on an audio track. */
export function decoupleAudio(store: EditorStore, videoClipId: string): string | null {
  let audioId: string | null = null;
  store.update("Extract audio", (p) => {
    const v = clip(p, videoClipId) as VideoClip | undefined;
    if (!v || v.kind !== "video") return;
    v.useOwnAudio = false;
    let audioTrack = p.tracks.find((t) => t.kind === "audio");
    if (!audioTrack) {
      audioTrack = { id: newId("t"), kind: "audio", name: "Audio", gain: 1, pan: 0 };
      p.tracks.push(audioTrack);
    }
    const a: AudioClip = {
      id: newId("c"),
      kind: "audio",
      trackId: audioTrack.id,
      mediaId: v.mediaId,
      start: v.start,
      duration: v.duration,
      inPoint: v.inPoint,
      speed: v.speed,
      audio: structuredClone(v.audio),
    };
    p.clips.push(a);
    audioId = a.id;
  });
  return audioId;
}
