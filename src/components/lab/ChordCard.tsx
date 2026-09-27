import type { MouseEvent } from "react";
import type { Chord, HarmonicFunction } from "../../lib/theory";
import { cx } from "../ui";

/** Fixed hues, so they stay distinct whichever accent colour is chosen. */
export const FUNCTION_COLORS: Record<HarmonicFunction, string> = {
  tonic: "#6FA3D8",
  subdominant: "#5DBB8A",
  dominant: "#D9A441",
};
export const FUNCTION_LABELS: Record<HarmonicFunction, string> = { tonic: "Tonic", subdominant: "Subdominant", dominant: "Dominant" };

export function FunctionDot({ fn }: { fn: HarmonicFunction }) {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: FUNCTION_COLORS[fn] }} />;
}

/** A chord to click: its numeral, name and notes, and what it does in the key (or `note` instead). */
export function ChordCard({
  chord,
  onClick,
  note,
  pressed,
  title,
}: {
  chord: Chord;
  onClick: (e: MouseEvent) => void;
  note?: string;
  pressed?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title ?? chord.notes.join(" ")}
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 pt-2 pb-1.5 text-left transition-colors active:bg-raised",
        pressed ? "border-accent bg-accent-soft" : "border-line2 bg-panel hover:border-text3",
      )}
    >
      <span className="text-[16px] font-semibold tracking-[-0.01em]">{chord.roman}</span>
      <span className="truncate font-mono text-small text-text2">{chord.name}</span>
      <span className="truncate font-mono text-[10.5px] text-text3">{chord.notes.join(" ")}</span>
      <span className="mt-0.5 flex items-center gap-1.5 truncate text-[10.5px] text-text3">
        <FunctionDot fn={chord.fn} />
        {note ?? FUNCTION_LABELS[chord.fn]}
      </span>
    </button>
  );
}
