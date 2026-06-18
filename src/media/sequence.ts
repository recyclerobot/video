// Image-sequence support: detect numeric runs in dropped files and decode
// frames lazily with an LRU cache + small read-ahead prefetch window.
import type { MediaAsset } from "../types";
import { getBlob } from "../storage";

export interface DetectedSequence {
  /** Display name, e.g. "frame_###.png (480)". */
  name: string;
  /** Files sorted by frame number. */
  files: File[];
}

export interface SequenceDetection {
  sequences: DetectedSequence[];
  singles: File[];
}

const NUM_RE = /^(.*?)(\d+)(\.[^.]+)$/;

/** Group files that share a prefix + extension with a numeric run into sequences. */
export function detectSequences(files: File[]): SequenceDetection {
  const groups = new Map<string, { num: number; file: File }[]>();
  const singles: File[] = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) {
      singles.push(f);
      continue;
    }
    const m = NUM_RE.exec(f.name);
    if (!m) {
      singles.push(f);
      continue;
    }
    const key = `${m[1]}#${m[3]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ num: parseInt(m[2], 10), file: f });
  }
  const sequences: DetectedSequence[] = [];
  for (const [key, items] of groups) {
    if (items.length < 2) {
      for (const it of items) singles.push(it.file);
      continue;
    }
    items.sort((a, b) => a.num - b.num);
    const base = key.split("#")[0] || "sequence";
    sequences.push({
      name: `${base}###  (${items.length} frames)`,
      files: items.map((i) => i.file),
    });
  }
  return { sequences, singles };
}

/** Map timeline-local time to a source frame index for a sequence clip. */
export function frameIndexFor(
  localTime: number,
  inFrame: number,
  speed: number,
  sourceFps: number,
  frameCount: number,
  holdLast: boolean,
): number {
  let idx = Math.floor(inFrame + localTime * speed * sourceFps);
  if (idx >= frameCount) idx = holdLast ? frameCount - 1 : idx % frameCount;
  return Math.max(0, Math.min(frameCount - 1, idx));
}

// ---- frame cache ----
interface CacheEntry {
  bitmap: ImageBitmap;
  lastUsed: number;
}

export class SequenceFrameCache {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<ImageBitmap | null>>();
  private tick = 0;
  constructor(private maxEntries = 60) {}

  private key(mediaId: string, idx: number): string {
    return `${mediaId}:${idx}`;
  }

  /** Synchronous get if cached (for render); returns null if not yet loaded. */
  peek(media: MediaAsset, idx: number): ImageBitmap | null {
    const e = this.cache.get(this.key(media.id, idx));
    if (e) {
      e.lastUsed = ++this.tick;
      return e.bitmap;
    }
    return null;
  }

  async load(media: MediaAsset, idx: number): Promise<ImageBitmap | null> {
    const k = this.key(media.id, idx);
    const hit = this.cache.get(k);
    if (hit) {
      hit.lastUsed = ++this.tick;
      return hit.bitmap;
    }
    if (this.inflight.has(k)) return this.inflight.get(k)!;
    const ids = media.frameBlobIds;
    if (!ids || idx < 0 || idx >= ids.length) return null;
    const p = (async () => {
      const blob = await getBlob(ids[idx]);
      if (!blob) return null;
      try {
        const bitmap = await createImageBitmap(blob);
        this.put(k, bitmap);
        return bitmap;
      } catch {
        return null;
      } finally {
        this.inflight.delete(k);
      }
    })();
    this.inflight.set(k, p);
    return p;
  }

  /** Warm the next few frames so scrubbing/playback stays smooth. */
  prefetch(media: MediaAsset, idx: number, ahead = 4): void {
    for (let i = 1; i <= ahead; i++) void this.load(media, idx + i);
  }

  private put(key: string, bitmap: ImageBitmap): void {
    this.cache.set(key, { bitmap, lastUsed: ++this.tick });
    if (this.cache.size > this.maxEntries) {
      let oldestKey = "";
      let oldest = Infinity;
      for (const [k, e] of this.cache) {
        if (e.lastUsed < oldest) {
          oldest = e.lastUsed;
          oldestKey = k;
        }
      }
      const e = this.cache.get(oldestKey);
      if (e) {
        e.bitmap.close();
        this.cache.delete(oldestKey);
      }
    }
  }

  clear(): void {
    for (const e of this.cache.values()) e.bitmap.close();
    this.cache.clear();
  }
}
