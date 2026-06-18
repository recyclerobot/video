// Rich text rendering for TitleClips. Renders to a frame-sized 2D canvas which
// the compositor uploads as a layer source (so titles transform/filter and
// z-order with video). Animation presets contribute opacity + transform deltas.
import type { TitleClip } from "../types";

export interface TitleAnim {
  opacity: number;
  /** normalized x/y deltas (same convention as Transform.x/y; +y = down). */
  dx: number;
  dy: number;
  scale: number;
  visibleChars: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (t: number) => t * (2 - t);

export function computeTitleAnim(c: TitleClip, localTime: number): TitleAnim {
  const a = c.animation;
  const totalChars = c.text.length;
  const inP = a.inDuration > 0 ? clamp01(localTime / a.inDuration) : 1;
  const fromEnd = c.duration - localTime;
  const outP = a.outDuration > 0 ? clamp01(fromEnd / a.outDuration) : 1;
  const env = Math.min(inP, outP);
  const anim: TitleAnim = { opacity: 1, dx: 0, dy: 0, scale: 1, visibleChars: totalChars };
  switch (a.preset) {
    case "fade":
      anim.opacity = env;
      break;
    case "slide-up":
      anim.opacity = env;
      anim.dy = (1 - easeOut(inP)) * 0.18;
      break;
    case "slide-left":
      anim.opacity = env;
      anim.dx = (1 - easeOut(inP)) * 0.25;
      break;
    case "pop":
      anim.opacity = env;
      anim.scale = 0.6 + easeOut(inP) * 0.4;
      break;
    case "typewriter":
      anim.visibleChars = Math.round(totalChars * inP);
      anim.opacity = outP;
      break;
    case "none":
    default:
      break;
  }
  return anim;
}

let scratch: HTMLCanvasElement | null = null;

function getCanvas(w: number, h: number): HTMLCanvasElement {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  return scratch;
}

/** Render a title onto a frame-sized canvas centered; caller positions via transform. */
export function renderTitleToCanvas(
  c: TitleClip,
  W: number,
  H: number,
  localTime: number,
  canvas?: HTMLCanvasElement | OffscreenCanvas,
): HTMLCanvasElement | OffscreenCanvas {
  const cv = canvas ?? getCanvas(W, H);
  const ctx = cv.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, W, H);

  const anim = computeTitleAnim(c, localTime);
  const visible =
    c.animation.preset === "typewriter" ? c.text.slice(0, anim.visibleChars) : c.text;
  const lines = visible.split("\n");

  const weight = c.fontWeight || 400;
  const style = c.italic ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${c.fontSize}px ${c.fontFamily || "system-ui"}, system-ui, sans-serif`;
  ctx.textAlign = c.align;
  ctx.textBaseline = "middle";
  try {
    (ctx as CanvasRenderingContext2D).letterSpacing = `${c.letterSpacing || 0}px`;
  } catch {
    /* not all engines support letterSpacing */
  }

  const lineH = c.fontSize * (c.lineHeight || 1.2);
  const totalH = lines.length * lineH;
  const cx = W / 2;
  const cy = H / 2;

  // measure widest line for the background box
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);

  // background box
  if (c.bgColor && c.bgColor !== "transparent") {
    const pad = c.bgPadding;
    const bx = cx - maxW / 2 - pad;
    const by = cy - totalH / 2 - pad;
    const bw = maxW + pad * 2;
    const bh = totalH + pad * 2;
    ctx.fillStyle = c.bgColor;
    roundRect(ctx, bx, by, bw, bh, c.bgRadius);
    ctx.fill();
  }

  // shadow
  if (c.shadow.enabled) {
    ctx.shadowColor = c.shadow.color;
    ctx.shadowBlur = c.shadow.blur;
    ctx.shadowOffsetX = c.shadow.x;
    ctx.shadowOffsetY = c.shadow.y;
  }

  const tx =
    c.align === "left" ? cx - maxW / 2 : c.align === "right" ? cx + maxW / 2 : cx;

  lines.forEach((ln, i) => {
    const y = cy - totalH / 2 + lineH * (i + 0.5);
    if (c.strokeWidth > 0) {
      ctx.lineWidth = c.strokeWidth;
      ctx.strokeStyle = c.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(ln, tx, y);
    }
    ctx.fillStyle = c.color;
    ctx.fillText(ln, tx, y);
  });
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  return cv;
}

function roundRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
