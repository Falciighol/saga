import { useRef } from "react";

export interface Scale {
  toPos: (v: number) => number;
  fromPos: (p: number) => number;
}

export const linearScale = (min: number, max: number): Scale => ({
  toPos: (v) => (v - min) / (max - min),
  fromPos: (p) => min + p * (max - min),
});

export const logScale = (min: number, max: number): Scale => {
  const lo = Math.log(min);
  const hi = Math.log(max);
  return {
    toPos: (v) => (Math.log(Math.max(v, min)) - lo) / (hi - lo),
    fromPos: (p) => Math.exp(lo + p * (hi - lo)),
  };
};

/**
 * Two-thumb slider where either end can be open: a thumb pushed to the edge means "no limit".
 */
export function RangeSlider({
  value,
  onChange,
  scale,
  round,
  label,
  width,
}: {
  value: [number | null, number | null];
  onChange: (v: [number | null, number | null]) => void;
  scale: Scale;
  round: (v: number) => number;
  label: string;
  width: number;
}) {
  const track = useRef<HTMLDivElement>(null);
  const lo = value[0] == null ? 0 : Math.max(0, Math.min(1, scale.toPos(value[0])));
  const hi = value[1] == null ? 1 : Math.max(0, Math.min(1, scale.toPos(value[1])));

  const posFromEvent = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const emit = (a: number, b: number) => {
    const edge = 0.004;
    onChange([a <= edge ? null : round(scale.fromPos(a)), b >= 1 - edge ? null : round(scale.fromPos(b))]);
  };

  const startDrag = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = posFromEvent(ev.clientX);
      if (which === 0) emit(Math.min(p, hi), hi);
      else emit(lo, Math.max(p, lo));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onTrackDown = (e: React.PointerEvent) => {
    const p = posFromEvent(e.clientX);
    const which: 0 | 1 = Math.abs(p - lo) <= Math.abs(p - hi) ? 0 : 1;
    if (which === 0) emit(Math.min(p, hi), hi);
    else emit(lo, Math.max(p, lo));
    startDrag(which)(e);
  };

  const key = (which: 0 | 1) => (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.01 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.01 : 0;
    if (!d) return;
    e.preventDefault();
    const step = e.shiftKey ? d * 5 : d;
    if (which === 0) emit(Math.max(0, Math.min(hi, lo + step)), hi);
    else emit(lo, Math.min(1, Math.max(lo, hi + step)));
  };

  const thumb = (which: 0 | 1, p: number) => (
    <span
      role="slider"
      tabIndex={0}
      aria-label={`${label} ${which === 0 ? "minimum" : "maximum"}`}
      aria-valuenow={which === 0 ? (value[0] ?? undefined) : (value[1] ?? undefined)}
      onPointerDown={startDrag(which)}
      onKeyDown={key(which)}
      className="absolute top-0 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-[3px] border-panel bg-text shadow-[0_0_0_1px_var(--line2)] focus-visible:outline-2"
      style={{ left: `${p * 100}%` }}
    />
  );

  return (
    <div className="relative h-3.5" style={{ width }} onPointerDown={onTrackDown} ref={track}>
      <div className="absolute top-[5px] right-0 left-0 h-1 rounded-full bg-raised2" />
      <div className="absolute top-[5px] h-1 bg-accent-wave" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
      {thumb(0, lo)}
      {thumb(1, hi)}
    </div>
  );
}

/** Bars for a distribution, with the selected range highlighted. */
export function Histogram({
  counts,
  width,
  height,
  isSelected,
}: {
  counts: number[];
  width: number;
  height: number;
  isSelected: (bin: number) => boolean;
}) {
  const max = Math.max(1, ...counts);
  const bw = width / Math.max(1, counts.length);
  return (
    <svg width={width} height={height} aria-hidden="true" className="block">
      {counts.map((c, i) => {
        const h = c === 0 ? 0 : Math.max(2, Math.sqrt(c / max) * height);
        return (
          <rect
            key={i}
            x={i * bw + 1}
            y={height - h}
            width={Math.max(1, bw - 2)}
            height={h}
            rx={1}
            style={{ fill: isSelected(i) ? "var(--accent-wave)" : "var(--line2)" }}
          />
        );
      })}
    </svg>
  );
}
