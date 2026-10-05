import { usesToken, type DateStyle, type KeyStyle, type NumberEach, type RenamePattern } from "../lib/rename";
import { cx, Segmented, Switch } from "./ui";

/** Highest first number {n} takes; more digits than this is never a sample folder. */
const MAX_FROM = 99999;

/** How each token is written: the rows under the name in the Rename dialog. A row is dimmed while
 *  the template doesn't use its token, but stays editable so it can be set up first. */
export function RenameStyles({ p, set }: { p: RenamePattern; set: (patch: Partial<RenamePattern>) => void }) {
  const label = (text: string, token: string) => <span className={cx("text-ui", usesToken(p.template, token) ? "text-text2" : "text-text3")}>{text}</span>;
  return (
    <>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5">
        {label("Key", "key")}
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<KeyStyle>
            label="Key style"
            size="sm"
            value={p.keyStyle}
            onChange={(keyStyle) => set({ keyStyle })}
            options={[
              { value: "short", label: "F#m" },
              { value: "compact", label: "F#min" },
              { value: "abbrev", label: "F# Min" },
              { value: "long", label: "F# minor" },
              { value: "camelot", label: "11A", title: "Camelot" },
            ]}
          />
          <Switch size="sm" checked={p.relativeMajor} onChange={(relativeMajor) => set({ relativeMajor })} label={<span className="text-small">Minor keys as their relative major (F#m → A)</span>} />
        </div>
        {label("Tempo", "bpm")}
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<"whole" | "exact">
            label="Tempo style"
            size="sm"
            value={p.bpmWhole ? "whole" : "exact"}
            onChange={(v) => set({ bpmWhole: v === "whole" })}
            options={[
              { value: "whole", label: "124", title: "Rounded to whole beats" },
              { value: "exact", label: "123.45", title: "As stored, up to two decimals" },
            ]}
          />
          <Switch size="sm" checked={p.bpmSuffix} onChange={(bpmSuffix) => set({ bpmSuffix })} label={<span className="text-small">Add “BPM” after it (124 BPM)</span>} />
        </div>
        {label("Date", "date")}
        <Segmented<DateStyle>
          label="Date style"
          size="sm"
          className="justify-self-start"
          value={p.dateStyle}
          onChange={(dateStyle) => set({ dateStyle })}
          options={[
            { value: "ymd", label: "2026-10-03" },
            { value: "compact", label: "20261003" },
            { value: "dmy", label: "03-10-2026" },
            { value: "mdy", label: "10-03-2026" },
          ]}
        />
        {label("Number", "n")}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-small text-text2">
            Start at
            <input
              type="number"
              min={0}
              max={MAX_FROM}
              value={p.numberFrom}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (e.target.value !== "" && Number.isFinite(n)) set({ numberFrom: Math.max(0, Math.min(MAX_FROM, n)) });
              }}
              aria-label="First number"
              className="h-7 w-16 rounded-md border border-line2 bg-raised px-2 font-mono text-small text-text tabular outline-none focus:border-accent"
            />
          </label>
          <Segmented<string>
            label="Number digits"
            size="sm"
            value={String(p.numberDigits)}
            onChange={(v) => set({ numberDigits: Number(v) })}
            options={[
              { value: "1", label: "1", title: "No zeros in front" },
              { value: "2", label: "01", title: "Two digits" },
              { value: "3", label: "001", title: "Three digits" },
            ]}
          />
          <Segmented<NumberEach>
            label="Count numbers"
            size="sm"
            value={p.numberEach}
            onChange={(numberEach) => set({ numberEach })}
            options={[
              { value: "selection", label: "Across the selection", title: "One count through everything you're renaming, in the list's order" },
              { value: "folder", label: "In each folder", title: "Each folder starts again from the first number" },
            ]}
          />
        </div>
      </div>
      <Switch
        checked={p.skipExisting}
        onChange={(skipExisting) => set({ skipExisting })}
        className="self-start"
        label={<span className="text-ui">Leave out a tempo or key the name already has</span>}
      />
    </>
  );
}
