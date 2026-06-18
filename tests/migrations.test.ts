import { describe, it, expect } from "vitest";
import { migrate } from "../src/state/migrations";
import { isAnimated } from "../src/engine/keyframes";

describe("migrations v1 → v2", () => {
  const v1 = {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      { id: "t_title", name: "Titles", kind: "title" },
      { id: "t_v1", name: "Video 1", kind: "video" },
      { id: "t_a1", name: "Audio 1", kind: "audio" },
      { id: "t_fx", name: "FX", kind: "effect" },
    ],
    clips: [
      { id: "c1", kind: "video", trackId: "t_v1", start: 0, duration: 5, mediaId: "m1", inPoint: 0, speed: 1, useOwnAudio: true, volume: 0.8 },
      { id: "c2", kind: "title", trackId: "t_title", start: 1, duration: 2, text: "Hi", fontSize: 40, color: "#fff", bgColor: "transparent", x: 0.25, y: 0.75 },
      { id: "c3", kind: "effect", trackId: "t_fx", start: 0, duration: 3, brightness: 1.2, contrast: 1.1, saturation: 1, hue: 10, tint: "#ff0000", tintAmount: 0.2 },
    ],
    media: [{ id: "m1", name: "a.mp4", type: "video", size: 10, duration: 5 }],
  };

  it("upgrades to schema version 2", () => {
    const p = migrate(structuredClone(v1));
    expect(p.version).toBe(2);
    expect(p.id).toBeTruthy();
    expect(p.masterGain).toBe(1);
  });

  it("converts video volume into audio props + adds transform/filters", () => {
    const p = migrate(structuredClone(v1));
    const v = p.clips.find((c) => c.id === "c1")! as any;
    expect(v.audio.volume).toBe(0.8);
    expect(v.transform).toBeTruthy();
    expect(Array.isArray(v.filters)).toBe(true);
  });

  it("maps title 0..1 position into -1..1 transform offset", () => {
    const p = migrate(structuredClone(v1));
    const t = p.clips.find((c) => c.id === "c2")! as any;
    expect(t.transform.x).toBeCloseTo(-0.5); // 0.25*2-1
    expect(t.transform.y).toBeCloseTo(0.5); // 0.75*2-1
  });

  it("converts an effect clip into a colorgrade filter", () => {
    const p = migrate(structuredClone(v1));
    const e = p.clips.find((c) => c.id === "c3")! as any;
    expect(e.filters.length).toBe(1);
    expect(e.filters[0].type).toBe("colorgrade");
    expect(e.filters[0].params.brightness).toBe(1.2);
  });

  it("leaves new keyframe fields as constants", () => {
    const p = migrate(structuredClone(v1));
    const v = p.clips.find((c) => c.id === "c1")! as any;
    expect(isAnimated(v.transform.opacity)).toBe(false);
  });
});
