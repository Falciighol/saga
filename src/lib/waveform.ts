import { pixelRatio } from "./scale";

const cache = new Map<string, Uint8Array>();

/** Decodes the base64 envelope from the backend (512 bytes), memoized. */
export function decodePeaks(b64: string | null): Uint8Array | null {
  if (!b64) return null;
  let hit = cache.get(b64);
  if (hit) return hit;
  const bin = atob(b64);
  hit = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) hit[i] = bin.charCodeAt(i);
  if (cache.size > 4000) cache.clear();
  cache.set(b64, hit);
  return hit;
}

/** Max-downsamples the envelope to `count` bars in 0..1, with a gentle curve so tails stay visible. */
export function toBars(peaks: Uint8Array, count: number): Float32Array {
  const out = new Float32Array(count);
  const n = peaks.length;
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * n) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / count));
    let m = 0;
    for (let j = start; j < end; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = Math.pow(m / 255, 0.8);
  }
  return out;
}

export interface DrawOptions {
  width: number;
  height: number;
  step: number;
  barWidth: number;
  color: string;
  playedColor?: string;
  /** 0..1 position of the playhead. */
  progress?: number;
  /** Playing backwards: the played part is to the right of the playhead. */
  reverse?: boolean;
}

/** Draws mirrored, round-capped bars. */
export function drawBars(ctx: CanvasRenderingContext2D, bars: Float32Array | null, o: DrawOptions) {
  ctx.clearRect(0, 0, o.width, o.height);
  const count = Math.floor(o.width / o.step);
  const mid = o.height / 2;
  const maxAmp = mid - o.barWidth / 2 - 0.5;
  ctx.lineCap = "round";
  ctx.lineWidth = o.barWidth;
  if (!bars) {
    // Not analyzed yet: a quiet dotted baseline.
    ctx.fillStyle = o.color;
    for (let i = 0; i < count; i += 2) ctx.fillRect(i * o.step, mid - 0.5, o.barWidth, 1);
    return;
  }
  const cut = o.progress != null ? Math.round(o.progress * count) : -1;
  const pass = (from: number, to: number, color: string) => {
    if (to <= from) return;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const v = bars[Math.min(bars.length - 1, Math.floor((i * bars.length) / count))];
      const a = Math.max(0.35, v * maxAmp);
      const x = i * o.step + o.step / 2;
      ctx.moveTo(x, mid - a);
      ctx.lineTo(x, mid + a);
    }
    ctx.stroke();
  };
  if (cut >= 0 && o.playedColor && o.reverse) {
    pass(0, cut, o.color);
    pass(cut, count, o.playedColor);
  } else if (cut >= 0 && o.playedColor) {
    pass(0, cut, o.playedColor);
    pass(cut, count, o.color);
  } else {
    pass(0, count, o.color);
  }
}

/** Sizes a canvas for crisp drawing on HiDPI screens and at any interface zoom, and returns its context. */
export function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = pixelRatio();
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
