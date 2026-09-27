import { useState } from "react";
import { ESTIMATE, fmtBpm } from "../../lib/format";
import { camelot } from "../../lib/keys";
import { isPlain, noteFrom, rankKeys, rankScales, rootName, scaleNotes, sharpName, type KeyMatch } from "../../lib/theory";
import type { SampleRow } from "../../lib/types";
import { useBrowse } from "../../store/browse";
import { playNote, playScale, useLab, type FinderSource } from "../../store/lab";
import { cx, Segmented, SectionLabel } from "../ui";
import { ViewToggle } from "../ViewToggle";
import { Keyboard } from "./Keyboard";
import { KeyActions } from "./LabSide";
import { missingProfile, PickASample, SampleCard, usePitchProfile } from "./SampleCard";

const SOURCES: { value: FinderSource; label: string; title: string }[] = [
  { value: "sample", label: "Selected sample", title: "The notes Saga heard when it analysed the sample selected in the list" },
  { value: "notes", label: "Notes I hear", title: "Pick the notes you hear on the keyboard" },
];

/** Scores this close are too close to call from the evidence. */
const TIE = 0.03;
/** Below this, no key explains the notes well (detection itself asks for 0.75). */
const WEAK = 0.5;

/** Picked notes as a profile, the home note counting double so keys on it rank first. */
function notesProfile(notes: number[], home: number | null): number[] | null {
  if (!notes.length) return null;
  return Array.from({ length: 12 }, (_, n) => (n === home ? 2 : notes.includes(n) ? 1 : 0));
}

/** "A minor", "C major", or a scale by name: "D Dorian". */
function matchName(m: KeyMatch): string {
  return `${rootName(m.pc, m.scale.mode)} ${isPlain(m.scale) ? (m.scale.mode === 1 ? "minor" : "major") : m.scale.name}`;
}

function pct(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

function tagged(row: SampleRow | null): { pc: number; mode: 0 | 1 } | null {
  return row && row.keyPc != null && (row.keyMode === 0 || row.keyMode === 1) ? { pc: row.keyPc, mode: row.keyMode } : null;
}

function MatchRow({ m, rank, on, note, onPick }: { m: KeyMatch; rank: number; on: boolean; note?: string; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cx(
        "grid min-h-[34px] w-full grid-cols-[14px_minmax(0,1fr)_44px_30px] items-center gap-2 rounded-md px-2 text-left transition-colors",
        on ? "bg-raised2 text-text" : "text-text2 hover:bg-raised hover:text-text",
      )}
    >
      <span className="font-mono text-micro text-text3">{rank}</span>
      <span className="flex min-w-0 items-baseline gap-1.5 text-ui">
        <span className="min-w-0 truncate">{matchName(m)}</span>
        {isPlain(m.scale) && <span className="shrink-0 font-mono text-micro text-text3">{camelot(m.pc, m.scale.mode)}</span>}
        {note && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10.5px] text-accent-ink">{note}</span>}
      </span>
      <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-raised2">
        <i className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, pct(m.score))}%` }} />
      </span>
      <span className="text-right font-mono text-small text-text2 tabular">{pct(m.score)}%</span>
    </button>
  );
}

/** The twelve notes by how much of the sound is on each, the chosen match's notes in the accent colour. */
function ProfileBars({ chroma, match }: { chroma: number[]; match: KeyMatch | null }) {
  const max = Math.max(...chroma, 1e-6);
  const inMatch = match ? scaleNotes(match.pc, match.scale.steps) : [];
  return (
    <div role="group" aria-label="Pitch profile" className="grid h-[118px] grid-cols-12 items-end gap-1">
      {chroma.map((v, n) => {
        const on = inMatch.includes(n);
        return (
          <button
            key={n}
            type="button"
            onClick={() => playNote(noteFrom(n, 0))}
            title={`${sharpName(n)}: ${Math.round((v / max) * 100)}% of the strongest note`}
            className={cx("group flex h-full min-w-0 flex-col items-center justify-end gap-1 font-mono text-[10.5px]", on ? "text-text" : "text-text3")}
          >
            <i
              className={cx("block w-full rounded-t-[3px] rounded-b-[1px] transition-colors", on ? "bg-accent" : "bg-raised2 group-hover:bg-line2")}
              style={{ height: Math.max(3, (v / max) * 90) }}
            />
            {sharpName(n)}
          </button>
        );
      })}
    </div>
  );
}

function NotePicker() {
  const notes = useLab((s) => s.finderNotes);
  const home = useLab((s) => s.finderHome);
  const lit = useLab((s) => s.lit);
  const set = useLab((s) => s.set);
  const toggle = (midi: number) => {
    const n = midi % 12;
    const on = notes.includes(n);
    set({ finderNotes: on ? notes.filter((x) => x !== n) : [...notes, n].sort((a, b) => a - b), finderHome: on && home === n ? null : home });
    if (!on) playNote(midi);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex">
        <Keyboard pc={home} lit={lit} onNote={toggle} picked={notes} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-ui text-text2">Home note</span>
        {notes.length ? (
          <Segmented
            size="sm"
            label="Home note"
            value={home ?? -1}
            onChange={(v) => set({ finderHome: v < 0 ? null : v })}
            options={[{ value: -1, label: "Not sure" }, ...notes.map((n) => ({ value: n, label: <span className="font-mono">{sharpName(n)}</span> }))]}
          />
        ) : (
          <span className="text-small text-text3">Pick some notes first</span>
        )}
        <div className="flex-1" />
        {notes.length > 0 && (
          <button type="button" onClick={() => set({ finderNotes: [], finderHome: null })} className="h-7 rounded-md border border-line2 px-2.5 text-small text-text2 hover:bg-raised hover:text-text">
            Clear notes
          </button>
        )}
      </div>
      <p className="text-small text-text3">Click the notes you hear in a loop or a melody; the octave doesn't matter. The note it keeps coming back to is its home.</p>
    </div>
  );
}

/** The chosen match on a keyboard, to play over the sample and hear whether it fits. */
function PlayAlong({ match }: { match: KeyMatch }) {
  const lit = useLab((s) => s.lit);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Play along in {matchName(match)}</SectionLabel>
        <span className="truncate text-micro text-text3">Play the sample (Space), then these keys over it</span>
      </div>
      <div className="flex">
        <Keyboard pc={match.pc} scale={match.scale} lit={lit} onNote={playNote} />
      </div>
    </div>
  );
}

function sampleDetail(row: SampleRow): string {
  const parts = [row.pack];
  if (row.kind === "loop" && row.bpm) parts.push(`${fmtBpm(row.bpm)} BPM`);
  const from: Record<string, string> = { name: `${row.key} in its name`, metadata: `${row.key} in its loop data`, audio: `${ESTIMATE}${row.key}, detected` };
  parts.push(row.key ? (from[row.keySource ?? ""] ?? row.key) : "no key in its name or tags");
  return parts.join(" · ");
}

export function KeyFinder() {
  const source = useLab((s) => s.finderSource);
  const notes = useLab((s) => s.finderNotes);
  const home = useLab((s) => s.finderHome);
  const set = useLab((s) => s.set);
  const selected = useBrowse((s) => s.selected);
  const row = source === "sample" ? selected : null;
  const { loading, profile } = usePitchProfile(row);

  const chroma = source === "notes" ? notesProfile(notes, home) : profile && profile.chroma.some((v) => v > 0) ? profile.chroma : null;
  const chromaKey = chroma?.join(",") ?? "";
  const keys = chroma ? rankKeys(chroma) : [];
  const scales = chroma ? rankScales(chroma) : [];
  // The chosen match, until the notes change.
  const [choice, setChoice] = useState<{ for: string; pc: number; scaleId: string } | null>(null);
  const all = [...keys, ...scales];
  const match = (choice?.for === chromaKey ? all.find((m) => m.pc === choice.pc && m.scale.id === choice.scaleId) : undefined) ?? keys[0] ?? null;
  const pick = (m: KeyMatch) => {
    setChoice({ for: chromaKey, pc: m.pc, scaleId: m.scale.id });
    playScale(m.pc, m.scale);
  };

  const tag = source === "sample" ? tagged(row) : null;
  const tie = keys.length > 1 && keys[0].score - keys[1].score < TIE;
  const weak = keys.length > 0 && keys[0].score < WEAK;

  let status: string | null = null;
  if (source === "sample" && row) {
    if (loading) status = "Reading the notes Saga stored for this sample…";
    else if (!profile) status = missingProfile(row);
    else if (!chroma) status = "Saga heard no clear notes in this sample: it's most likely a drum hit or noise.";
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <Segmented label="Listen to" value={source} onChange={(v) => set({ finderSource: v })} options={SOURCES} />
        <span className="truncate text-small text-text3 @max-[900px]:hidden">
          {source === "sample" ? "Uses what Saga heard when it analysed the file" : "For a loop outside Saga, or a tune in your head"}
        </span>
        <div className="flex-1" />
        <ViewToggle />
      </div>

      <div className="@container/lab min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col @min-[860px]/lab:h-full @min-[860px]/lab:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 py-4 @min-[860px]/lab:overflow-y-auto">
            {source === "notes" ? <NotePicker /> : row ? <SampleCard row={row} detail={sampleDetail(row)} /> : <PickASample what="find its key" />}

            {status ? (
              <p className="text-ui text-text3">{status}</p>
            ) : (
              chroma && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionLabel>Pitch profile</SectionLabel>
                    <span className="truncate text-micro text-text3">How much of the sound is on each note · click to hear it</span>
                  </div>
                  <ProfileBars chroma={chroma} match={match} />
                  <p className="text-small text-text3">
                    {match && (
                      <>
                        Highlighted: the notes of {matchName(match)}.{" "}
                      </>
                    )}
                    {source === "sample" && "Overtones count too, so a note's fifth often shows up a little. "}
                    {source === "notes"
                      ? home == null && notes.length >= 3 && "Keys with the same notes rank close together: pick the note that feels like home to tell them apart."
                      : tie && "The top keys are close; the note the music keeps returning to decides between them."}
                  </p>
                </div>
              )
            )}

            {source === "sample" && chroma && match && <PlayAlong match={match} />}
          </div>

          <aside
            aria-label="Matches"
            className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] content-start gap-x-8 gap-y-5 border-t border-line bg-panel px-5 py-4 @min-[860px]/lab:flex @min-[860px]/lab:w-[300px] @min-[860px]/lab:flex-col @min-[860px]/lab:overflow-y-auto @min-[860px]/lab:border-t-0 @min-[860px]/lab:border-l @min-[860px]/lab:px-4"
          >
            {!chroma ? (
              <p className="text-ui text-text3">
                {source === "notes" ? "Pick the notes you hear, and the keys and scales that hold them show here." : "Keys and scales that fit the selected sample show here."}
              </p>
            ) : (
              <>
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionLabel>Likely keys</SectionLabel>
                    <span className="text-micro text-text3">Major and minor</span>
                  </div>
                  <div className="flex flex-col">
                    {keys.map((m, i) => (
                      <MatchRow
                        key={`${m.pc}${m.scale.id}`}
                        m={m}
                        rank={i + 1}
                        on={m === match}
                        note={tag && tag.pc === m.pc && tag.mode === m.scale.mode ? (row?.keySource === "audio" ? "detected" : "tagged") : undefined}
                        onPick={() => pick(m)}
                      />
                    ))}
                  </div>
                  {weak && <p className="text-small text-text3">No key fits clearly. The sound may be mostly drums or noise, or move between keys.</p>}
                </section>

                <section className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <SectionLabel>Scales that fit</SectionLabel>
                    <span className="text-micro text-text3">Modes and colours</span>
                  </div>
                  <div className="flex flex-col">
                    {scales.map((m, i) => (
                      <MatchRow key={`${m.pc}${m.scale.id}`} m={m} rank={i + 1} on={m === match} onPick={() => pick(m)} />
                    ))}
                  </div>
                </section>

                {match && (
                  <>
                    <p className="rounded-[10px] bg-raised px-3 py-2.5 text-ui leading-normal text-text2">
                      <b className="font-semibold text-text">{matchName(match)}.</b>{" "}
                      {match.scale.feel}
                    </p>
                    <KeyActions pc={match.pc} scale={match.scale} />
                    <button
                      type="button"
                      onClick={() => useLab.getState().set({ pc: match.pc, scaleId: match.scale.id, tool: "scales" })}
                      className="h-8 self-start rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
                    >
                      Open in Scales
                    </button>
                  </>
                )}
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
