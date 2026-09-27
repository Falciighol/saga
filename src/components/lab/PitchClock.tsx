import { colourDegrees, spell, type Scale } from "../../lib/theory";

const SIZE = 188;
const C = SIZE / 2;
const R = 64;
const R_LABEL = 82;

function at(iv: number, r: number): [number, number] {
  const a = (iv / 12) * 2 * Math.PI;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

/**
 * The scale on a 12-note circle with its root at the top, so every scale draws the same shape
 * whatever its key. Colour notes (what sets it apart from major or minor) are ringed.
 */
export function PitchClock({ pc, scale }: { pc: number; scale: Scale }) {
  const names = spell(pc, scale);
  const colour = colourDegrees(scale).map((i) => scale.steps[i]);
  const poly = scale.steps.map((iv) => at(iv, R).map((v) => v.toFixed(1)).join(",")).join(" ");
  const steps = scale.steps.map((v, i) => (scale.steps[i + 1] ?? 12) - v).join(" ");
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Scale shape: steps ${steps}`} className="shrink-0">
      <circle cx={C} cy={C} r={R} fill="none" style={{ stroke: "var(--line2)" }} />
      <polygon points={poly} strokeWidth={1.5} strokeLinejoin="round" style={{ fill: "var(--accent-soft)", stroke: "var(--accent)" }} />
      {Array.from({ length: 12 }, (_, iv) => {
        const i = scale.steps.indexOf(iv);
        const [x, y] = at(iv, R);
        const [lx, ly] = at(iv, R_LABEL);
        const root = iv === 0;
        return (
          <g key={iv}>
            <circle
              cx={x}
              cy={y}
              r={root ? 6.5 : i >= 0 ? 4.5 : 2.5}
              strokeWidth={colour.includes(iv) ? 3 : 0}
              paintOrder="stroke"
              style={{ fill: root ? "var(--accent)" : i >= 0 ? "var(--text)" : "var(--line2)", stroke: "var(--accent)" }}
            />
            {i >= 0 && (
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central" className="font-mono text-[11px]" style={{ fill: root ? "var(--text)" : "var(--text2)", fontWeight: root ? 600 : 400 }}>
                {names[i]}
              </text>
            )}
          </g>
        );
      })}
      <text x={C} y={C - 8} textAnchor="middle" className="text-[9.5px] font-semibold tracking-[0.06em] uppercase" style={{ fill: "var(--text3)" }}>
        Steps
      </text>
      <text x={C} y={C + 9} textAnchor="middle" className="font-mono text-[11px]" style={{ fill: "var(--text)" }}>
        {steps}
      </text>
    </svg>
  );
}
