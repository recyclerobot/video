// Pointer/touch gesture helpers. Every drag in the editor goes through
// `beginDrag` so the same code path works with a mouse, a pen or a finger.
// Long-press stands in for right-click, and `attachPinch` adds two-finger
// zoom/scale on top of the browser's own one-finger scrolling.

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
const TAP_SLOP = 10;

export interface DragOptions {
  /** Movement since pointerdown, in CSS pixels. */
  onMove(dx: number, dy: number, ev: PointerEvent): void;
  /** `canceled` is true when the browser took over the gesture (scroll, pinch). */
  onEnd?(canceled: boolean): void;
}

export interface DragHandle {
  /** Abort the drag as if the browser had canceled it. */
  cancel(): void;
}

/** True for the gesture we treat as a drag: primary pointer, primary button. */
export function isPrimaryDrag(ev: PointerEvent): boolean {
  return ev.isPrimary && ev.button <= 0;
}

/**
 * Track a drag until pointerup/pointercancel. Listeners live on `window` so the
 * drag survives the pointer leaving the element (and survives re-renders of the
 * element itself, which the timeline does constantly).
 */
export function beginDrag(ev: PointerEvent, opts: DragOptions): DragHandle {
  const id = ev.pointerId;
  const startX = ev.clientX;
  const startY = ev.clientY;
  let done = false;

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    opts.onMove(e.clientX - startX, e.clientY - startY, e);
  };
  const finish = (canceled: boolean): void => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    opts.onEnd?.(canceled);
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId === id) finish(false);
  };
  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId === id) finish(true);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  return { cancel: () => finish(true) };
}

/** Touch/pen long-press — the finger equivalent of a right-click. */
export function onLongPress(el: HTMLElement, fn: (ev: PointerEvent) => void): void {
  let timer = 0;
  let sx = 0;
  let sy = 0;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    sx = e.clientX;
    sy = e.clientY;
    clear();
    timer = window.setTimeout(() => {
      timer = 0;
      fn(e);
    }, LONG_PRESS_MS);
  });
  el.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > LONG_PRESS_SLOP) clear();
  });
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
}

/** Detects a finger tap (press + release without travelling). */
export class TapTracker {
  private x = 0;
  private y = 0;
  private armed = false;

  down(ev: PointerEvent): void {
    this.armed = ev.pointerType !== "mouse" && ev.isPrimary;
    this.x = ev.clientX;
    this.y = ev.clientY;
  }
  /** True when this pointerup completes a tap. Always disarms. */
  up(ev: PointerEvent): boolean {
    const ok =
      this.armed && Math.hypot(ev.clientX - this.x, ev.clientY - this.y) <= TAP_SLOP;
    this.armed = false;
    return ok;
  }
  reset(): void {
    this.armed = false;
  }
}

export interface PinchPoint {
  x: number;
  y: number;
}

export interface PinchOptions {
  onStart?(center: PinchPoint): void;
  /** `scale` is the distance ratio against the start of the gesture. */
  onChange(scale: number, center: PinchPoint): void;
  onEnd?(): void;
}

/**
 * Two-finger pinch. Deliberately uses touch events rather than pointer events:
 * the element may also be a native scroll container, and the browser cancels
 * pointers when it starts a pan — touch events keep reporting both fingers.
 */
export function attachPinch(el: HTMLElement, opts: PinchOptions): void {
  let startDist = 0;
  let active = false;
  const dist = (t: TouchList): number =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const center = (t: TouchList): PinchPoint => ({
    x: (t[0].clientX + t[1].clientX) / 2,
    y: (t[0].clientY + t[1].clientY) / 2,
  });

  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 2) return;
      active = true;
      startDist = Math.max(1, dist(e.touches));
      opts.onStart?.(center(e.touches));
    },
    { passive: true },
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      if (!active || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      opts.onChange(dist(e.touches) / startDist, center(e.touches));
    },
    { passive: false },
  );
  const end = (): void => {
    if (!active) return;
    active = false;
    opts.onEnd?.();
  };
  el.addEventListener("touchend", end, { passive: true });
  el.addEventListener("touchcancel", end, { passive: true });
}

/** Touch-first device (phone/tablet) — used to pick tap-friendly affordances. */
export function isCoarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}
