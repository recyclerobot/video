import { describe, it, expect } from "vitest";
import { EditorStore } from "../src/state/store";
import {
  splitClip,
  removeClips,
  copySelection,
  pasteClipboard,
  duplicateSelection,
} from "../src/state/commands";
import { defaultProject, defaultTransform, defaultAudioProps, type VideoClip } from "../src/types";

function storeWithClip(): EditorStore {
  const p = defaultProject();
  const clip: VideoClip = {
    id: "c1", kind: "video", trackId: "t_v1", mediaId: "m1", start: 2, duration: 6,
    inPoint: 0, speed: 1, useOwnAudio: true, transform: defaultTransform(), filters: [], audio: defaultAudioProps(),
  };
  p.clips.push(clip);
  return new EditorStore(p);
}

describe("editing commands", () => {
  it("splits a clip at a time, preserving inPoint", () => {
    const store = storeWithClip();
    const newId = splitClip(store, "c1", 5);
    expect(newId).toBeTruthy();
    const clips = store.getProject().clips;
    const left = clips.find((c) => c.id === "c1") as VideoClip;
    const right = clips.find((c) => c.id === newId) as VideoClip;
    expect(left.duration).toBeCloseTo(3);
    expect(right.start).toBe(5);
    expect(right.duration).toBeCloseTo(3);
    expect(right.inPoint).toBeCloseTo(3);
  });

  it("ripple delete shifts later clips left", () => {
    const store = storeWithClip();
    store.update("add", (p) => {
      const c = structuredClone(p.clips[0]);
      c.id = "c2";
      c.start = 8;
      p.clips.push(c);
    });
    removeClips(store, ["c1"], true);
    const c2 = store.getProject().clips.find((c) => c.id === "c2")!;
    expect(c2.start).toBeCloseTo(2); // 8 - 6
  });

  it("copy + paste creates a new clip at the playhead", () => {
    const store = storeWithClip();
    store.setSelection(["c1"]);
    copySelection(store);
    pasteClipboard(store, 10);
    expect(store.getProject().clips.length).toBe(2);
    const pasted = store.getProject().clips.find((c) => c.id !== "c1")!;
    expect(pasted.start).toBe(10);
  });

  it("duplicate drops a copy after the original", () => {
    const store = storeWithClip();
    store.setSelection(["c1"]);
    duplicateSelection(store);
    const clips = store.getProject().clips;
    expect(clips.length).toBe(2);
    const dup = clips.find((c) => c.id !== "c1")!;
    expect(dup.start).toBeCloseTo(8); // 2 + 6
  });

  it("undo reverses a destructive edit", () => {
    const store = storeWithClip();
    removeClips(store, ["c1"]);
    expect(store.getProject().clips.length).toBe(0);
    store.undo();
    expect(store.getProject().clips.length).toBe(1);
    store.redo();
    expect(store.getProject().clips.length).toBe(0);
  });
});
