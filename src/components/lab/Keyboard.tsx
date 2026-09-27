import { degreeName, scaleNotes, sharpName, type Scale } from "../../lib/theory";
import { cx } from "../ui";

const WHITES = [0, 2, 4, 5, 7, 9, 11];
/** Index of the white key a black key sits after. */
const BLACK_AFTER: Record<number, number> = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };

/**
 * A clickable keyboard from C3 with the scale's degrees marked and sounding notes lit. Keys sound
 * on press; Enter or Space sounds a focused key. With `picked`, it marks those notes instead (named,
 * `pc` as the home note) and each key toggles one.
 */
export function Keyboard({
  pc,
  scale,
  lit,
  onNote,
  octaves = 2,
  picked,
}: {
  pc: number | null;
  scale?: Scale;
  lit: number[];
  onNote: (midi: number) => void;
  octaves?: number;
  picked?: number[];
}) {
  const notes = picked ?? (scale && pc != null ? scaleNotes(pc, scale.steps) : []);
  const mark = (n: number) => (!notes.includes(n) ? null : picked || !scale || pc == null ? sharpName(n) : degreeName((n - pc + 12) % 12, scale.steps));
  const w = 100 / (octaves * 7);
  const whites = [];
  const blacks = [];
  for (let o = 0; o < octaves; o++) {
    for (let n = 0; n < 12; n++) {
      const midi = 48 + o * 12 + n;
      const inScale = notes.includes(n);
      const root = n === pc;
      const on = lit.includes(midi);
      const degree = mark(n);
      const label = `${sharpName(n)}${3 + o}${degree && !picked ? `, degree ${degree}` : ""}`;
      if (WHITES.includes(n)) {
        whites.push(
          <button
            key={midi}
            type="button"
            aria-label={label}
            aria-pressed={picked ? inScale : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              onNote(midi);
            }}
            onClick={(e) => e.detail === 0 && onNote(midi)}
            className={cx(
              "absolute top-0 flex h-full flex-col items-center justify-end gap-0.5 rounded-b-md border border-t-0 border-line2 pb-1.5 font-mono text-micro transition-[filter] duration-75",
              root ? "bg-accent text-on-accent" : inScale ? "text-text" : "bg-raised text-text3",
              on && "brightness-125",
            )}
            style={{
              left: `${(o * 7 + WHITES.indexOf(n)) * w}%`,
              width: `${w}%`,
              background: !root && inScale ? "color-mix(in srgb, var(--accent) 24%, var(--seg))" : undefined,
              boxShadow: on ? "inset 0 -3px 0 var(--accent)" : undefined,
            }}
          >
            {degree && <span className="font-medium">{degree}</span>}
            {n === 0 && <span className={root ? "" : "text-text3"}>C{3 + o}</span>}
          </button>,
        );
      } else {
        blacks.push(
          <button
            key={midi}
            type="button"
            aria-label={label}
            aria-pressed={picked ? inScale : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              onNote(midi);
            }}
            onClick={(e) => e.detail === 0 && onNote(midi)}
            className={cx(
              "absolute top-0 z-10 flex h-[62%] flex-col items-center justify-end rounded-b-[5px] border border-t-0 border-line2 pb-1 font-mono text-[10px] transition-[filter] duration-75",
              root ? "bg-accent text-on-accent" : "text-(--key-black-text)",
              on && "brightness-150",
            )}
            style={{
              left: `${(o * 7 + BLACK_AFTER[n] + 1 - 0.3) * w}%`,
              width: `${w * 0.6}%`,
              background: root ? undefined : inScale ? "color-mix(in srgb, var(--accent) 38%, var(--key-black))" : "var(--key-black)",
              boxShadow: on ? "inset 0 -3px 0 var(--accent)" : undefined,
            }}
          >
            {degree && <span className={root ? "" : "text-text"}>{degree}</span>}
          </button>,
        );
      }
    }
  }
  return (
    <div role="group" aria-label="Keyboard" className="relative h-[120px] min-w-[300px] flex-1 select-none">
      {whites}
      {blacks}
    </div>
  );
}
