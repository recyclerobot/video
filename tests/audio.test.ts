import { describe, it, expect } from "vitest";
import { audioSources } from "../src/engine/audio";
import { defaultProject, defaultAudioProps, defaultTransform, type AudioClip, type VideoClip } from "../src/types";

function project() {
  const p = defaultProject();
  const v: VideoClip = {
    id: "v1", kind: "video", trackId: "t_v1", mediaId: "mv", start: 0, duration: 5,
    inPoint: 0, speed: 1, useOwnAudio: true, transform: defaultTransform(), filters: [], audio: defaultAudioProps(),
  };
  const a: AudioClip = {
    id: "a1", kind: "audio", trackId: "t_a1", mediaId: "ma", start: 0, duration: 5,
    inPoint: 0, speed: 1, audio: defaultAudioProps(),
  };
  p.clips.push(v, a);
  return p;
}

describe("audio source selection", () => {
  it("includes video (with own audio) + audio clips", () => {
    expect(audioSources(project()).length).toBe(2);
  });

  it("excludes video when useOwnAudio is false", () => {
    const p = project();
    (p.clips[0] as VideoClip).useOwnAudio = false;
    expect(audioSources(p).map((s) => s.clip.id)).toEqual(["a1"]);
  });

  it("excludes muted tracks", () => {
    const p = project();
    p.tracks.find((t) => t.id === "t_a1")!.muted = true;
    expect(audioSources(p).map((s) => s.clip.id)).toEqual(["v1"]);
  });

  it("solo restricts audio tracks to soloed ones", () => {
    const p = project();
    p.tracks.find((t) => t.id === "t_a1")!.solo = true;
    // video track is not an audio track, so it still plays; only non-solo AUDIO tracks are cut
    const ids = audioSources(p).map((s) => s.clip.id).sort();
    expect(ids).toEqual(["a1", "v1"]);
  });
});
