import { describe, it, expect } from "vitest";
import {
  sampleAt,
  addKeyframe,
  removeKeyframe,
  hasKeyframeAt,
  isAnimated,
} from "../src/engine/keyframes";

describe("keyframes", () => {
  it("returns constants unchanged", () => {
    expect(sampleAt(0.5, 10)).toBe(0.5);
  });

  it("interpolates linearly between keyframes", () => {
    const v = { keys: [
      { time: 0, value: 0, easing: "linear" as const },
      { time: 2, value: 10, easing: "linear" as const },
    ] };
    expect(sampleAt(v, 0)).toBe(0);
    expect(sampleAt(v, 1)).toBeCloseTo(5);
    expect(sampleAt(v, 2)).toBe(10);
  });

  it("clamps outside the keyframe range", () => {
    const v = { keys: [
      { time: 1, value: 4, easing: "linear" as const },
      { time: 3, value: 8, easing: "linear" as const },
    ] };
    expect(sampleAt(v, 0)).toBe(4);
    expect(sampleAt(v, 9)).toBe(8);
  });

  it("holds value with hold easing", () => {
    const v = { keys: [
      { time: 0, value: 1, easing: "hold" as const },
      { time: 2, value: 9, easing: "linear" as const },
    ] };
    expect(sampleAt(v, 1.9)).toBe(1);
  });

  it("adds, detects and removes keyframes", () => {
    let v = addKeyframe(5, 1, 7);
    expect(isAnimated(v)).toBe(true);
    expect(hasKeyframeAt(v, 1)).toBe(true);
    v = addKeyframe(v, 2, 3) as typeof v;
    expect(v.keys.length).toBe(3); // original 0, plus 1 and 2
    const collapsed = removeKeyframe(v, 1);
    expect(hasKeyframeAt(collapsed, 1)).toBe(false);
  });

  it("keeps keyframes sorted by time", () => {
    let v = addKeyframe(0, 3, 1);
    v = addKeyframe(v, 1, 1) as typeof v;
    const times = v.keys.map((k) => k.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
