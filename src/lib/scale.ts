import { getCurrentWebview } from "@tauri-apps/api/webview";
import { create } from "zustand";

/** Interface sizes offered in Settings and stepped through with ⌘+ / ⌘−. */
export const SCALES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** The next size up or down from `current`, stopping at the ends. */
export function stepScale(current: number, dir: 1 | -1): number {
  if (dir > 0) return SCALES.find((s) => s > current + 1e-6) ?? SCALES[SCALES.length - 1];
  return [...SCALES].reverse().find((s) => s < current - 1e-6) ?? SCALES[0];
}

const usePixelRatioStore = create<{ ratio: number }>(() => ({ ratio: window.devicePixelRatio || 1 }));

/** Screen pixels per interface pixel, for crisp canvases. Components that draw should redraw when it changes. */
export const usePixelRatio = () => usePixelRatioStore((s) => s.ratio);

export const pixelRatio = () => usePixelRatioStore.getState().ratio;

/**
 * Works out screen pixels per interface pixel at the given zoom. WebKit leaves devicePixelRatio
 * alone when the page is zoomed and WebView2 includes the zoom in it, so compare against the
 * webview's real size to tell which.
 */
export async function measurePixelRatio(zoom: number): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  let ratio = dpr;
  try {
    const { width } = await getCurrentWebview().size();
    const measured = width / window.innerWidth;
    if (Math.abs(measured - dpr * zoom) < Math.abs(measured - dpr)) ratio = dpr * zoom;
  } catch {
    // Outside Tauri; devicePixelRatio is all there is.
  }
  usePixelRatioStore.setState({ ratio });
}
