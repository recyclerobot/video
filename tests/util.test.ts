import { describe, it, expect } from "vitest";
import { fmtTime, fmtTimecode, clamp } from "../src/util";
import { modelMatrix } from "../src/engine/transform";
import { defaultTransform } from "../src/types";

describe("time utils", () => {
  it("formats mm:ss.cc", () => {
    expect(fmtTime(0)).toBe("00:00.00");
    expect(fmtTime(65.5)).toBe("01:05.50");
  });
  it("formats timecode with frames", () => {
    expect(fmtTimecode(1, 30)).toBe("00:01:00");
    expect(fmtTimecode(1.5, 30)).toBe("00:01:15");
  });
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
});

describe("transform matrix", () => {
  it("produces a 3x3 matrix", () => {
    const m = modelMatrix(defaultTransform(), 1920, 1080, 1920, 1080, 0);
    expect(m.length).toBe(9);
  });
  it("contain fit shrinks a wide source vertically into a square frame", () => {
    const t = defaultTransform();
    const m = modelMatrix(t, 1920, 1080, 1000, 1000, 0);
    // y-scale (m[4]) should be < x-scale (m[0]) for a wide source in a square frame
    expect(Math.abs(m[4])).toBeLessThan(Math.abs(m[0]) + 1e-6);
  });
});
