// 3x3 affine matrix helpers for positioning a unit quad ([-1,1]^2) in NDC.
// Used by the compositor's draw-source pass so each layer can be
// scaled / rotated / positioned independently (PiP, pan & zoom, etc.).
import { sampleAt } from "./keyframes";
import type { Transform } from "../types";

export type Mat3 = Float32Array; // column-major, length 9

function identity(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] =
        a[0 * 3 + r] * b[c * 3 + 0] +
        a[1 * 3 + r] * b[c * 3 + 1] +
        a[2 * 3 + r] * b[c * 3 + 2];
    }
  }
  return o;
}

function scale(sx: number, sy: number): Mat3 {
  return new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]);
}
function translate(tx: number, ty: number): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1]);
}
function rotate(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
}

/**
 * Build the model matrix for a source of `srcW`x`srcH` drawn into a
 * `frameW`x`frameH` frame, honoring fit/scale/rotation/position at `localTime`.
 */
export function modelMatrix(
  t: Transform,
  srcW: number,
  srcH: number,
  frameW: number,
  frameH: number,
  localTime: number,
): Mat3 {
  const frameAR = frameW / frameH;
  const srcAR = srcW > 0 && srcH > 0 ? srcW / srcH : frameAR;

  let sx = 1;
  let sy = 1;
  if (t.fit === "contain") {
    if (srcAR > frameAR) sy = frameAR / srcAR;
    else sx = srcAR / frameAR;
  } else if (t.fit === "cover") {
    if (srcAR > frameAR) sx = srcAR / frameAR;
    else sy = frameAR / srcAR;
  }
  const userScale = sampleAt(t.scale, localTime);
  const rot = (sampleAt(t.rotation, localTime) * Math.PI) / 180;
  const tx = sampleAt(t.x, localTime);
  const ty = -sampleAt(t.y, localTime); // screen y grows downward; NDC up

  // Aspect-correct the rotation so it stays circular in pixel space.
  const A = scale(frameAR, 1);
  const Ainv = scale(1 / frameAR, 1);
  const R = mul(Ainv, mul(rotate(rot), A));

  let m = identity();
  m = mul(scale(sx * userScale, sy * userScale), m);
  m = mul(R, m);
  m = mul(translate(tx, ty), m);
  return m;
}

export const cropVec = (t: Transform): [number, number, number, number] => [
  t.crop.left,
  t.crop.top,
  t.crop.right,
  t.crop.bottom,
];
