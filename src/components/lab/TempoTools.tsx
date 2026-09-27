import { useState } from "react";
import { copyText } from "../../lib/actions";
import { fmtBpm } from "../../lib/format";
import { keyLongName, projectKeyLabel } from "../../lib/keys";
import { computeProcessing, type Edit, type Project } from "../../lib/processing";
import { hzToMidi, noteHz, noteLabel, scaleById, scaleLabel, scaleNotes, SCALES, sharpName, spell, type Scale } from "../../lib/theory";
import type { PitchProfile, SampleRow } from "../../lib/types";
import { useBrowse } from "../../store/browse";
import { playNotes, useLab } from "../../store/lab";
import { projectScale, useEdit, useEdits, useProject } from "../../store/project";
import { clampBpm, useTapTempo } from "../ProjectControls";
import { cx, Segmented, SectionLabel } from "../ui";
import { ViewToggle } from "../ViewToggle";
import { missingProfile, PickASample, SampleCard, usePitchProfile } from "./SampleCard";

/** Note values in beats. */
const LENGTHS: { label: string; beats: number; note?: string }[] = [
  { label: "1 bar", beats: 4 },
  { label: "1/2", beats: 2 },
  { label: "1/4", beats: 1, note: "beat" },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
  { label: "1/64", beats: 0.0625 },
];
const BARS = [1, 2, 4, 8, 16, 32];
const OCTAVES = [
  { value: 1, label: "Sub", title: "Octave 1, from C1 at 32.7 Hz: 808s and sub bass" },
  { value: 2, label: "Bass", title: "Octave 2, from C2 at 65.4 Hz: kicks and bass" },
  { value: 3, label: "Low", title: "Octave 3, from C3 at 130.8 Hz" },
  { value: 4, label: "Mid", title: "Octave 4, from middle C at 261.6 Hz" },
];
const REFS = [
  { value: 440, label: "A = 440", title: "Standard tuning" },
  { value: 432, label: "A = 432", title: "A4 at 432 Hz, about a third of a semitone lower" },
];
/** A clear enough pitch to tune by (detection asks the same of a one-shot's root note). */
const MIN_CLARITY = 0.5;

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(3)} s` : `${ms.toFixed(1)} ms`;
}

function fmtLong(s: number): string {
  if (s < 60) return `${s.toFixed(3)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** How far a MIDI note with a fraction sits from the nearest note, in cents. */
function centsOff(midi: number): number {
  return (midi - Math.round(midi)) * 100;
}

function fmtCents(c: number): string {
  const r = Math.round(c);
  return r === 0 ? "in tune" : `${r > 0 ? "+" : "−"}${Math.abs(r)}¢`;
}

/** A value you can click to copy, for typing into a delay or LFO. */
function Copy({ value, unit, children }: { value: number; unit: string; children: string }) {
  const text = String(Math.round(value * 100) / 100);
  return (
    <button type="button" onClick={() => void copyText(text, `${text} ${unit}`)} title={`Copy ${text} ${unit}`} className="rounded px-1 font-mono tabular hover:bg-raised2 hover:text-text">
      {children}
    </button>
  );
}

function BigTempo() {
  const bpm = useProject((s) => s.bpm);
  const set = useProject((s) => s.set);
  const [draft, setDraft] = useState<string | null>(null);
  const tap = useTapTempo((b) => set({ bpm: b }));
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v) && v > 0) set({ bpm: clampBpm(v) });
    setDraft(null);
  };
  const button = "h-8 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text active:bg-raised2";
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <label className="flex items-baseline gap-2">
        <input
          aria-label="Project tempo in BPM"
          value={draft ?? bpm.toFixed(2)}
          onFocus={(e) => {
            setDraft(bpm.toFixed(2));
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-[130px] border-b border-line2 bg-transparent py-0.5 font-mono text-[28px] font-medium tabular text-text outline-none focus:border-accent"
        />
        <span className="text-ui text-text3">BPM</span>
      </label>
      <div className="flex gap-1.5 pb-0.5">
        <button type="button" onClick={() => set({ bpm: clampBpm(bpm / 2) })} title="Half time" className={button}>
          ×½
        </button>
        <button type="button" onClick={() => set({ bpm: clampBpm(bpm * 2) })} title="Double time" className={button}>
          ×2
        </button>
        <button type="button" onClick={tap} title="Tap along to set the tempo (T)" className={button}>
          Tap
        </button>
      </div>
    </div>
  );
}

function NoteLengths({ bpm }: { bpm: number }) {
  const beat = 60_000 / bpm;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-ui">
        <thead>
          <tr className="text-micro font-semibold tracking-[0.06em] text-text3 uppercase">
            <th className="border-b border-line2 px-2 py-1.5 text-left font-semibold">Note</th>
            <th className="border-b border-line2 px-2 py-1.5 text-right font-semibold">Straight</th>
            <th className="border-b border-line2 px-2 py-1.5 text-right font-semibold">Dotted</th>
            <th className="border-b border-line2 px-2 py-1.5 text-right font-semibold">Triplet</th>
            <th className="border-b border-line2 px-2 py-1.5 text-right font-semibold">Rate</th>
          </tr>
        </thead>
        <tbody>
          {LENGTHS.map((l) => {
            const ms = beat * l.beats;
            return (
              <tr key={l.label} className={cx(l.note && "bg-accent-soft")}>
                <td className="border-b border-line px-2 py-1 whitespace-nowrap">
                  {l.label}
                  {l.note && <span className="ml-1.5 text-micro text-text3">{l.note}</span>}
                </td>
                {[ms, ms * 1.5, (ms * 2) / 3].map((v, i) => (
                  <td key={i} className="border-b border-line px-1 py-1 text-right whitespace-nowrap text-text2">
                    <Copy value={v} unit="ms">
                      {fmtMs(v)}
                    </Copy>
                  </td>
                ))}
                <td className="border-b border-line px-1 py-1 text-right whitespace-nowrap text-text2">
                  <Copy value={1000 / ms} unit="Hz">
                    {`${(1000 / ms).toFixed(3)} Hz`}
                  </Copy>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The key whose frequencies are shown: the project key, or the one open in Scales. */
function useToolKey(): { pc: number; scale: Scale; label: string; fromProject: boolean } {
  const key = useProject((s) => s.key);
  const pc = useLab((s) => s.pc);
  const scaleId = useLab((s) => s.scaleId);
  if (key) return { pc: key.pc, scale: projectScale(key), label: projectKeyLabel(key), fromProject: true };
  const scale = scaleById(scaleId) ?? SCALES[0];
  return { pc, scale, label: scaleLabel(pc, scale), fromProject: false };
}

function Frequencies({ pc, scale }: { pc: number; scale: Scale }) {
  const ref = useLab((s) => s.tuningRef);
  const octave = useLab((s) => s.tuningOctave);
  const names = spell(pc, scale);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-1">
      {scale.steps.map((iv, i) => {
        const midi = 12 * (octave + 1) + pc + iv;
        const hz = noteHz(midi, ref);
        return (
          <button
            key={iv}
            type="button"
            onClick={() => playNotes([{ note: midi, length: 1.2, velocity: 0.9 }])}
            title={`Play ${noteLabel(midi)}`}
            className={cx("flex flex-col gap-px rounded-md px-2 py-1.5 text-left", i === 0 ? "bg-accent text-on-accent" : "bg-accent-soft hover:brightness-105")}
          >
            <b className="font-mono text-ui font-medium">
              {names[i]}
              {Math.floor(midi / 12) - 1}
            </b>
            <span className={cx("font-mono text-[10.5px]", i === 0 ? "opacity-75" : "text-text3")}>{hz.toFixed(2)} Hz</span>
          </button>
        );
      })}
    </div>
  );
}

interface TunePlan {
  /** Where it rings in the file as a MIDI note with cents, when a pitch was measured. */
  heard: number | null;
  /** Semitones Match key moves it by. */
  matched: number;
  target: number;
  semitones: number;
  cents: number;
}

/**
 * The pitch edit that puts a one-shot on the nearest note of the scale: from its measured pitch
 * when it's clear (cents included), otherwise from the root note in its name. Any key match the
 * project applies is counted in, so the result lands on the note either way.
 */
function tunePlan(row: SampleRow, profile: PitchProfile | null, project: Project, edit: Edit, pc: number, scale: Scale, ref: number): TunePlan | null {
  const matched = computeProcessing(row, project, { ...edit, semitones: 0, cents: 0 }).semitones;
  const offset = 12 * Math.log2(ref / 440);
  const notes = scaleNotes(pc, scale.steps);
  const heard = profile?.hz != null && profile.clarity >= MIN_CLARITY ? hzToMidi(profile.hz) : null;
  let from: number;
  if (heard != null) from = heard + matched;
  else if (row.keyMode === 2 && row.keyPc != null) from = 60 + row.keyPc + matched;
  else return null;
  let best: number | null = null;
  for (let m = Math.floor(from) - 7; m <= Math.ceil(from) + 7; m++) {
    if (notes.includes(((m % 12) + 12) % 12) && (best == null || Math.abs(m + offset - from) < Math.abs(best + offset - from))) best = m;
  }
  if (best == null) return null;
  const shift = best + offset - from;
  const semitones = Math.round(shift);
  return { heard, matched, target: best, semitones, cents: Math.round((shift - semitones) * 100) };
}

function Tuner({ pc, scale, label }: { pc: number; scale: Scale; label: string }) {
  const row = useBrowse((s) => s.selected);
  const shot = row?.kind === "oneshot" ? row : null;
  const { loading, profile } = usePitchProfile(shot);
  const project = useProject();
  const edit = useEdit(shot?.id);
  const update = useEdits((s) => s.update);
  const ref = useLab((s) => s.tuningRef);

  if (!row) return <PickASample what="tune it" />;
  const card = <SampleCard row={row} detail={[row.pack, row.category, row.key ? `root ${row.key}` : null].filter(Boolean).join(" · ")} />;
  if (!shot) {
    return (
      <>
        {card}
        <p className="text-ui text-text3">Tuning is for one-shots. Loops follow the project key with Match key (K).</p>
      </>
    );
  }
  if (loading) return card;
  const plan = tunePlan(shot, profile, project, edit, pc, scale, ref);
  if (!plan) {
    return (
      <>
        {card}
        <p className="text-ui text-text3">
          {!profile
            ? missingProfile(shot)
            : shot.keyMode === 0 || shot.keyMode === 1
              ? `Saga couldn't hear one steady note, and its name gives a key, ${keyLongName(shot.keyPc!, shot.keyMode)}, rather than a note. Match key (K) moves it to the project key.`
              : "Saga couldn't hear a steady pitch in this sample, and its name has no root note, so there's nothing to tune by."}
        </p>
      </>
    );
  }
  const tuned = edit.semitones === plan.semitones && Math.abs(edit.cents - plan.cents) <= 2;
  const edited = edit.semitones !== 0 || edit.cents !== 0;
  const byName = plan.heard == null;
  const plays = (plan.heard ?? 0) + plan.matched + edit.semitones + edit.cents / 100;
  // Notes and cents are read against the chosen reference pitch.
  const offset = 12 * Math.log2(ref / 440);
  // Without a measured pitch the octave isn't known, only the note.
  const targetName = byName ? sharpName(plan.target) : noteLabel(plan.target);
  return (
    <>
      {card}
      <div className="flex flex-col gap-1 text-ui text-text2">
        {plan.heard != null ? (
          <>
            <span>
              Rings at <b className="font-mono font-medium text-text">{noteHz(plan.heard).toFixed(1)} Hz</b>: {noteLabel(plan.heard - offset)}, {fmtCents(centsOff(plan.heard - offset))}
            </span>
            {(edited || plan.matched !== 0) && !tuned && (
              <span>
                Plays at {noteLabel(plays - offset)}, {fmtCents(centsOff(plays - offset))}, with {edited ? "its pitch edit" : "Match key"}
              </span>
            )}
          </>
        ) : (
          <span>No steady pitch to measure; going by the root note in its name, {shot.key}.</span>
        )}
        <span>
          Nearest in {label}: <b className="font-medium text-text">{targetName}</b>
          {!byName && <span className="font-mono text-small text-text3"> {noteHz(plan.target, ref).toFixed(1)} Hz</span>}
          <span className="font-mono text-small text-text3">
            {" "}
            ({plan.semitones > 0 ? "+" : plan.semitones < 0 ? "−" : "±"}
            {Math.abs(plan.semitones)} st{plan.cents ? ` ${plan.cents > 0 ? "+" : "−"}${Math.abs(plan.cents)}¢` : ""})
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={tuned}
          onClick={() => update(shot.id, { semitones: plan.semitones, cents: plan.cents })}
          className={cx(
            "h-8 rounded-lg px-3 text-ui font-semibold transition-colors",
            tuned ? "border border-accent bg-accent-soft font-medium text-accent-ink" : "bg-accent text-on-accent hover:brightness-105",
          )}
        >
          {tuned ? `Tuned to ${targetName}` : `Tune to ${targetName}`}
        </button>
        {edited && (
          <button type="button" onClick={() => update(shot.id, { semitones: 0, cents: 0 })} className="h-8 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text">
            Reset pitch
          </button>
        )}
      </div>
      <p className="text-small text-text3">Sets the sample's pitch, as in the editor. Drag it out or save a variation to keep it.</p>
    </>
  );
}

export function TempoTools() {
  const bpm = useProject((s) => s.bpm);
  const ref = useLab((s) => s.tuningRef);
  const octave = useLab((s) => s.tuningOctave);
  const set = useLab((s) => s.set);
  const key = useToolKey();
  const beat = 60 / bpm;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <span className="truncate text-small text-text3">Uses the project tempo and key; changing the tempo here changes the project's.</span>
        <div className="flex-1" />
        <ViewToggle />
      </div>

      <div className="@container/lab min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col @min-[860px]/lab:h-full @min-[860px]/lab:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-5 px-5 py-4 @min-[860px]/lab:overflow-y-auto">
            <section className="flex flex-col gap-2">
              <SectionLabel>Project tempo</SectionLabel>
              <BigTempo />
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <SectionLabel>Note lengths</SectionLabel>
                <span className="truncate text-micro text-text3">For delays, LFOs, gates and sidechain release · click a value to copy it</span>
              </div>
              <NoteLengths bpm={bpm} />
            </section>

            <section className="flex flex-col gap-2">
              <SectionLabel>Bars</SectionLabel>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1">
                {BARS.map((n) => (
                  <div key={n} className="flex flex-col gap-px rounded-md bg-raised px-2 py-1.5">
                    <span className="text-micro text-text3">
                      {n} {n === 1 ? "bar" : "bars"}
                    </span>
                    <span className="-mx-1 text-ui text-text">
                      <Copy value={n * 4 * beat} unit="s">
                        {fmtLong(n * 4 * beat)}
                      </Copy>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <p className="rounded-[10px] bg-raised px-3 py-2.5 text-ui leading-normal text-text2">
              <b className="font-semibold text-text">Reverb that breathes with the track:</b> a pre-delay of {fmtMs((beat * 1000) / 16)} (1/64) keeps the attack dry, and a
              decay of {fmtMs(beat * 2000)} ends it on the half note. At {fmtBpm(bpm)} BPM a 16-step pattern lasts {fmtLong(beat * 4)}.
            </p>
          </div>

          <aside
            aria-label="Tuning"
            className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] content-start gap-x-8 gap-y-5 border-t border-line bg-panel px-5 py-4 @min-[860px]/lab:flex @min-[860px]/lab:w-[320px] @min-[860px]/lab:flex-col @min-[860px]/lab:overflow-y-auto @min-[860px]/lab:border-t-0 @min-[860px]/lab:border-l @min-[860px]/lab:px-4"
          >
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <SectionLabel>{key.label} in Hz</SectionLabel>
                {!key.fromProject && <span className="text-micro text-text3">From Scales</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Segmented size="sm" label="Octave" value={octave} onChange={(v) => set({ tuningOctave: v })} options={OCTAVES} />
                <Segmented size="sm" label="Reference pitch" value={ref} onChange={(v) => set({ tuningRef: v })} options={REFS} />
              </div>
              <Frequencies pc={key.pc} scale={key.scale} />
              {!key.fromProject && <p className="text-small text-text3">No project key is set, so this is the key open in Scales.</p>}
            </section>

            <section className="flex flex-col gap-2">
              <SectionLabel>Tune a one-shot</SectionLabel>
              <Tuner pc={key.pc} scale={key.scale} label={key.label} />
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

