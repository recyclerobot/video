// Downsampled waveform peaks for drawing audio clips on the timeline.
// Computed once per media source and cached on the MediaAsset.
let sharedCtx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!sharedCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/** Returns `buckets` peak magnitudes in 0..1 across the whole source. */
export async function computePeaks(blob: Blob, buckets = 1000): Promise<number[]> {
  const arr = await blob.arrayBuffer();
  const audio = await ctx().decodeAudioData(arr.slice(0));
  const ch = audio.getChannelData(0);
  const total = ch.length;
  const step = Math.max(1, Math.floor(total / buckets));
  const peaks: number[] = [];
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const startI = b * step;
    let peak = 0;
    for (let i = 0; i < step && startI + i < total; i++) {
      const v = Math.abs(ch[startI + i]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
  return peaks;
}
