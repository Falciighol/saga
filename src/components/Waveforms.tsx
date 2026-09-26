import { useEffect, useMemo, useRef } from "react";
import { usePalette } from "../hooks/useTheme";
import { usePixelRatio } from "../lib/scale";
import { decodePeaks, drawBars, setupCanvas, toBars } from "../lib/waveform";
import { playerPosition, usePlayer } from "../store/player";

/**
 * Small waveform for list rows. When `sampleId` is the one playing, it shows progress
 * and animates without re-rendering React.
 */
export function MiniWave({
  peaks,
  width,
  height,
  sampleId,
  emphasized,
}: {
  peaks: string | null;
  width: number;
  height: number;
  sampleId: number;
  emphasized: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colors = usePalette();
  const ratio = usePixelRatio();
  const status = usePlayer((s) => (s.id === sampleId ? s.status : "idle"));
  const step = 3;
  const bars = useMemo(() => {
    const p = decodePeaks(peaks);
    return p ? toBars(p, Math.floor(width / step)) : null;
  }, [peaks, width]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = (progress?: number) => {
      const ctx = setupCanvas(canvas, width, height);
      if (!ctx) return;
      drawBars(ctx, bars, {
        width,
        height,
        step,
        barWidth: 1.6,
        color: emphasized ? colors.wave2 : colors.wave,
        playedColor: colors.accentWave,
        progress,
        reverse: progress != null && usePlayer.getState().reverse,
      });
    };
    const progress = () => {
      const s = usePlayer.getState();
      const duration = s.row?.duration ?? 0;
      return duration > 0 ? playerPosition(s) / duration : 0;
    };
    if (status === "idle") {
      draw();
      return;
    }
    if (status !== "playing") {
      draw(progress());
      return;
    }
    let raf = 0;
    const loop = () => {
      draw(progress());
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [bars, width, height, emphasized, colors, ratio, status]);

  return <canvas ref={ref} style={{ width, height }} aria-hidden="true" className="block shrink-0" />;
}
