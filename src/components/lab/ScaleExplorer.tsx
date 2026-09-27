import { Play } from "lucide-react";
import type { MouseEvent } from "react";
import { camelot } from "../../lib/keys";
import {
  colourDegrees,
  degreeName,
  FAMILIES,
  MODE_BRIGHTNESS,
  rootName,
  SCALES,
  scaleById,
  scaleChords,
  spell,
  type Chord,
  type Scale,
} from "../../lib/theory";
import { chordNotes, placeChord, playChord, playNote, playScale, useLab } from "../../store/lab";
import { toast } from "../../store/toasts";
import { cx, Divider, Segmented, SectionLabel } from "../ui";
import { ViewToggle } from "../ViewToggle";
import { ChordCard } from "./ChordCard";
import { LabSide } from "./LabSide";
import { Keyboard } from "./Keyboard";
import { PitchClock } from "./PitchClock";

const MODE_SHORT: Record<string, string> = { lydian: "Lyd", ionian: "Maj", mixolydian: "Mix", dorian: "Dor", aeolian: "Min", phrygian: "Phr", locrian: "Loc" };

function pickScale(id: string) {
  useLab.getState().set({ scaleId: id });
  const { pc } = useLab.getState();
  playScale(pc, scaleById(id)!);
}

function ScaleList({ current }: { current: Scale }) {
  return (
    <div className="flex w-[212px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line px-2.5 py-3.5">
      {FAMILIES.map((f) => (
        <div key={f.id} role="group" aria-label={f.label} className="flex flex-col gap-px">
          <SectionLabel className="px-2 pb-1">{f.label}</SectionLabel>
          {SCALES.filter((x) => x.family === f.id).map((x) => {
            const on = x.id === current.id;
            return (
              <button
                key={x.id}
                type="button"
                aria-pressed={on}
                title={x.feel}
                onClick={() => pickScale(x.id)}
                className={cx(
                  "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-body transition-colors",
                  on ? "bg-raised2 text-text" : "text-text2 hover:bg-raised hover:text-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{x.name}</span>
                <span aria-hidden="true" className="flex shrink-0 gap-[2px]">
                  {Array.from({ length: 12 }, (_, k) => (
                    <i
                      key={k}
                      className="block h-2.5 w-[4px] rounded-[1px]"
                      style={{ background: x.steps.includes(k) ? (on ? "var(--accent)" : "var(--text3)") : "var(--line2)" }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Click to hear; Shift-click to put it in the progression's selected bar. */
function addOrPlay(pc: number, chord: Chord, e: MouseEvent) {
  if (!e.shiftKey) {
    playChord(chordNotes(pc, chord));
    return;
  }
  const { sketch, bar } = useLab.getState();
  placeChord({ iv: (pc + chord.iv - sketch.pc + 12) % 12, quality: chord.quality });
  toast(`${chord.name} is in bar ${bar + 1} of the progression`, "info");
}

export function ScaleExplorer() {
  const pc = useLab((s) => s.pc);
  const scaleId = useLab((s) => s.scaleId);
  const sevenths = useLab((s) => s.sevenths);
  const lit = useLab((s) => s.lit);
  const set = useLab((s) => s.set);
  const scale = scaleById(scaleId) ?? SCALES[0];
  const names = spell(pc, scale);
  const colour = colourDegrees(scale);
  const chords = scaleChords(pc, scale, sevenths);
  const family = FAMILIES.find((f) => f.id === scale.family)!.label;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <div role="group" aria-label="Root note" className="no-scrollbar flex min-w-0 gap-0.5 overflow-x-auto rounded-lg bg-raised p-[3px]">
          {Array.from({ length: 12 }, (_, n) => (
            <button
              key={n}
              type="button"
              aria-pressed={n === pc}
              onClick={() => {
                set({ pc: n });
                const tonic = scaleChords(n, scale, false)[0];
                if (tonic) playChord(chordNotes(n, tonic));
              }}
              className={cx(
                "h-[26px] min-w-8 shrink-0 rounded-md px-1.5 font-mono text-small transition-colors",
                n === pc ? "bg-accent font-medium text-on-accent" : "text-text2 hover:bg-raised2 hover:text-text",
              )}
            >
              {rootName(n, scale.mode)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Segmented
          size="sm"
          label="Chord size"
          value={sevenths ? "7" : "3"}
          onChange={(v) => set({ sevenths: v === "7" })}
          options={[
            { value: "3", label: "Triads" },
            { value: "7", label: "7ths" },
          ]}
        />
        <Divider />
        <ViewToggle />
      </div>

      <div className="flex min-h-0 flex-1">
        <ScaleList current={scale} />

        {/* Side by side when there's room; otherwise the details follow the scale and scroll with it. */}
        <div className="@container/lab min-w-0 flex-1 overflow-y-auto">
          <div className="flex flex-col @min-[860px]/lab:h-full @min-[860px]/lab:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 py-4 @min-[860px]/lab:overflow-y-auto">
              <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
                <div className="min-w-0">
                  <h2 className="text-[22px] font-semibold tracking-[-0.02em]">
                    {rootName(pc, scale.mode)} {scale.name}
                    {scale.alt && <span className="ml-2 text-[15px] font-normal text-text3">{scale.alt}</span>}
                  </h2>
                  <p className="mt-0.5 text-ui text-text2">{scale.feel}</p>
                </div>
                <button
                  type="button"
                  onClick={() => playScale(pc, scale)}
                  title="Play the scale (Space)"
                  className="flex h-8 items-center gap-2 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
                >
                  <Play size={12} fill="currentColor" strokeWidth={0} />
                  Play scale
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5 text-small text-text2">
                <span className="flex h-[22px] items-center rounded bg-raised2 px-2">{family}</span>
                <span className="flex h-[22px] items-center rounded bg-raised2 px-2">{scale.steps.length} notes</span>
                <span className="flex h-[22px] items-center gap-1.5 rounded bg-raised2 px-2">
                  Closest key {rootName(pc, scale.mode)} {scale.mode === 1 ? "min" : "maj"}
                  <span className="font-mono text-micro text-text3">{camelot(pc, scale.mode)}</span>
                </span>
                {colour.length > 0 && (
                  <span className="flex h-[22px] items-center rounded bg-raised2 px-2" title="The notes that set it apart from plain major or minor">
                    Colour {colour.length > 1 ? "notes" : "note"} {colour.map((i) => degreeName(scale.steps[i], scale.steps)).join(" ")}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-5">
                <PitchClock pc={pc} scale={scale} />
                <Keyboard pc={pc} scale={scale} lit={lit} onNote={playNote} />
              </div>

              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${scale.steps.length}, minmax(0, 1fr))` }}>
                {scale.steps.map((iv, i) => (
                  <div
                    key={iv}
                    className={cx("flex min-w-0 flex-col items-center gap-px rounded-md px-1 py-1.5", i === 0 ? "bg-accent-soft" : "bg-raised")}
                    style={colour.includes(i) ? { boxShadow: "inset 0 0 0 1px var(--accent)" } : undefined}
                  >
                    <b className="font-mono text-body font-medium">{names[i]}</b>
                    <span className="max-w-full truncate text-[10.5px] text-text3">
                      {degreeName(iv, scale.steps)}
                      {colour.includes(i) ? " · colour" : ""}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <SectionLabel>Chords in the scale</SectionLabel>
                  <span className="text-micro text-text3">Click to hear · Shift-click to add to the progression</span>
                </div>
                {chords.length ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
                    {chords.map((c) => (
                      <ChordCard
                        key={`${c.iv}${c.quality}`}
                        chord={c}
                        title={`${c.notes.join(" ")} · Shift-click to add to the progression`}
                        onClick={(e) => addOrPlay(pc, c, e)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-ui text-text3">No three-note chord fits inside this scale. It works best as a melody over a drone or a single bass note.</p>
                )}
              </div>

              {scale.family === "modes" && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionLabel>Mode brightness</SectionLabel>
                    <span className="text-micro text-text3">Same root, brightest to darkest</span>
                  </div>
                  <div role="group" aria-label="Modes by brightness" className="flex max-w-[420px] items-end gap-1">
                    {MODE_BRIGHTNESS.map((id, i) => {
                      const on = id === scale.id;
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={on}
                          title={scaleById(id)!.name}
                          onClick={() => pickScale(id)}
                          className={cx("group flex min-w-0 flex-1 flex-col items-center gap-1 text-[10.5px]", on ? "text-text" : "text-text3 hover:text-text")}
                        >
                          <i
                            className={cx("block w-full rounded-t-[3px] rounded-b-[1px] transition-colors", on ? "bg-accent" : "bg-raised2 group-hover:bg-line2")}
                            style={{ height: 12 + (6 - i) * 6 }}
                          />
                          {MODE_SHORT[id]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <LabSide pc={pc} scale={scale} />
          </div>
        </div>
      </div>
    </div>
  );
}
