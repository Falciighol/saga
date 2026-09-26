import { camelot, compatibleKeys, keyName, wheelKeys } from "../lib/keys";
import type { KeyFilter } from "../lib/types";

const SIZE = 240;
const C = SIZE / 2;
const R_OUT = 116;
const R_MID = 84;
const R_IN = 52;

function sector(r1: number, r2: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
  return `M${p(r1, a0)}A${r1} ${r1} 0 0 1 ${p(r1, a1)}L${p(r2, a1)}A${r2} ${r2} 0 0 0 ${p(r2, a0)}Z`;
}

/** Camelot wheel: outer ring majors (B), inner ring minors (A). Click a key to filter by it. */
export function KeyWheel({
  value,
  counts,
  onPick,
}: {
  value: KeyFilter | null;
  counts: number[] | undefined;
  onPick: (pc: number, mode: 0 | 1) => void;
}) {
  const compat = value?.compatible ? compatibleKeys(value.pc, value.mode) : [];
  const isSel = (pc: number, mode: 0 | 1) => value?.pc === pc && value.mode === mode;
  const isCompat = (pc: number, mode: 0 | 1) => !isSel(pc, mode) && compat.some((k) => k.pc === pc && k.mode === mode);

  const segs = [];
  for (let n = 1; n <= 12; n++) {
    const a = (n * 30 * Math.PI) / 180;
    const a0 = a - (15 * Math.PI) / 180;
    const a1 = a + (15 * Math.PI) / 180;
    const { minor, major } = wheelKeys(n);
    for (const [pc, mode, r1, r2, rl] of [
      [major, 0, R_OUT, R_MID, (R_OUT + R_MID) / 2],
      [minor, 1, R_MID, R_IN, (R_MID + R_IN) / 2],
    ] as const) {
      const sel = isSel(pc, mode);
      const cmp = isCompat(pc, mode);
      const empty = counts ? counts[pc * 2 + mode] === 0 : false;
      segs.push(
        <g
          key={`${n}${mode}`}
          role="button"
          tabIndex={0}
          aria-label={`${keyName(pc, mode)} (${camelot(pc, mode)})${sel ? ", selected" : ""}`}
          aria-pressed={sel}
          onClick={() => onPick(pc, mode)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPick(pc, mode);
            }
          }}
          className="cursor-default outline-none [&:focus-visible>path]:stroke-(--accent)"
        >
          <path
            d={sector(r1, r2, a0, a1)}
            strokeWidth={2}
            className="transition-[fill] duration-100 hover:brightness-125"
            style={{
              fill: sel ? "var(--accent)" : cmp ? "var(--accent-soft)" : "var(--raised)",
              stroke: "var(--panel)",
            }}
          />
          <text
            x={C + rl * Math.sin(a)}
            y={C - rl * Math.cos(a)}
            textAnchor="middle"
            dominantBaseline="central"
            className="pointer-events-none font-mono text-[10.5px]"
            style={{
              fill: sel ? "var(--on-accent)" : cmp ? "var(--text)" : empty ? "var(--text3)" : "var(--text2)",
              fontWeight: sel || cmp ? 500 : 400,
              opacity: empty && !sel ? 0.55 : 1,
            }}
          >
            {keyName(pc, mode)}
          </text>
        </g>,
      );
    }
  }

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-label="Key wheel">
      {segs}
      <text x={C} y={C - 6} textAnchor="middle" dominantBaseline="central" className="font-mono text-[18px] font-medium" style={{ fill: "var(--text)" }}>
        {value ? camelot(value.pc, value.mode) : "Any"}
      </text>
      <text x={C} y={C + 14} textAnchor="middle" dominantBaseline="central" className="text-[11px]" style={{ fill: "var(--text3)" }}>
        {value ? "Camelot" : "key"}
      </text>
    </svg>
  );
}
