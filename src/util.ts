// Small shared utilities.
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function fmtTime(t: number): string {
  if (!isFinite(t)) t = 0;
  const mm = Math.floor(t / 60);
  const ss = t - mm * 60;
  return `${String(mm).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}`;
}

export function fmtTimecode(t: number, fps: number): string {
  if (!isFinite(t)) t = 0;
  const total = Math.round(t * fps);
  const f = total % Math.round(fps);
  const secs = Math.floor(total / Math.round(fps));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!,
  );
}
