// Keyframe sampling + easing. Shared by preview and export so animation is
// deterministic and identical across both render paths.
import type { Animatable, Easing, Keyframe } from "../types";

export function isAnimated(v: Animatable): v is { keys: Keyframe[] } {
  return typeof v !== "number";
}

function ease(t: number, kind: Easing): number {
  switch (kind) {
    case "hold":
      return 0;
    case "ease-in":
      return t * t;
    case "ease-out":
      return t * (2 - t);
    case "ease-in-out":
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case "linear":
    default:
      return t;
  }
}

/**
 * Evaluate an animatable property at `localTime` (seconds relative to clip start).
 * Constants return as-is; keyframe lists interpolate with per-segment easing.
 */
export function sampleAt(prop: Animatable, localTime: number): number {
  if (typeof prop === "number") return prop;
  const keys = prop.keys;
  if (keys.length === 0) return 0;
  if (keys.length === 1) return keys[0].value;
  // Keys are kept sorted by time on insertion (see addKeyframe).
  if (localTime <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (localTime >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (localTime >= a.time && localTime <= b.time) {
      const span = b.time - a.time || 1e-6;
      const f = ease((localTime - a.time) / span, a.easing);
      if (a.easing === "hold") return a.value;
      return a.value + (b.value - a.value) * f;
    }
  }
  return last.value;
}

/** Read a filter param that may be animatable; non-numeric returns the fallback. */
export function sampleParam(
  v: number | { keys: Keyframe[] } | string | boolean | undefined,
  localTime: number,
  fallback = 0,
): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "keys" in v) return sampleAt(v, localTime);
  return fallback;
}

/** Insert/replace a keyframe at `time`, returning a new animatable value. */
export function addKeyframe(
  prop: Animatable,
  time: number,
  value: number,
  easing: Easing = "linear",
): { keys: Keyframe[] } {
  const keys: Keyframe[] = isAnimated(prop)
    ? prop.keys.slice()
    : [{ time: 0, value: prop, easing: "linear" }];
  const existing = keys.findIndex((k) => Math.abs(k.time - time) < 1e-4);
  if (existing >= 0) keys[existing] = { time, value, easing };
  else keys.push({ time, value, easing });
  keys.sort((a, b) => a.time - b.time);
  return { keys };
}

/** Remove the keyframe nearest `time` (within tolerance). Collapses to a constant if one remains. */
export function removeKeyframe(prop: Animatable, time: number): Animatable {
  if (!isAnimated(prop)) return prop;
  const keys = prop.keys.filter((k) => Math.abs(k.time - time) >= 1e-3);
  if (keys.length === 0) return 0;
  if (keys.length === 1) return keys[0].value;
  return { keys };
}

export function hasKeyframeAt(prop: Animatable, time: number): boolean {
  return isAnimated(prop) && prop.keys.some((k) => Math.abs(k.time - time) < 1e-3);
}
