import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, errorMessage, type NoteEvent, type SynthPreset, type TransportEvent } from "../lib/api";
import { fmtBpm } from "../lib/format";
import {
  BAR_COUNTS,
  emptyBars,
  keyLabel,
  patternNotes,
  presetSketch,
  PRESETS,
  resize,
  sketchScale,
  voicing,
  type ProgChord,
  type Sketch,
} from "../lib/progressions";
import { COLLECTION_COLORS } from "../lib/theme";
import { noteFrom, SCALES, scaleById, type Chord, type Scale } from "../lib/theory";
import { useProject } from "./project";
import { toast } from "./toasts";

export type LabTool = "scales" | "progressions" | "finder" | "tempo";

/** What the key finder listens to: the selected sample's stored profile, or notes you pick. */
export type FinderSource = "sample" | "notes";

/** A progression kept in the rail. Edits to it save as you go. */
export interface Idea {
  id: string;
  color: string;
  sketch: Sketch;
}

interface LabValues {
  tool: LabTool;
  /** Root of the scale being explored. */
  pc: number;
  scaleId: string;
  /** Chords are shown as sevenths instead of triads. */
  sevenths: boolean;
  preset: SynthPreset;
  /** The progression being sketched. */
  sketch: Sketch;
  /** The saved idea the sketch is, if any. */
  ideaId: string | null;
  ideas: Idea[];
  finderSource: FinderSource;
  /** Pitch classes picked on the key finder's keyboard. */
  finderNotes: number[];
  /** The picked note that feels like home, if you've said. */
  finderHome: number | null;
  /** Tempo & tuning: the pitch of A4 in Hz, and the octave the key's frequencies are shown in. */
  tuningRef: number;
  tuningOctave: number;
}

export interface Transport {
  playing: boolean;
  /** Beats since the progression started at `at` (performance.now()); the playhead extrapolates. */
  beat: number;
  bpm: number;
  at: number;
}

interface LabState extends LabValues {
  /** MIDI notes sounding now, so the keyboard can light them. */
  lit: number[];
  /** The bar chords from the palette go into. */
  bar: number;
  transport: Transport;
  set: (patch: Partial<LabValues>) => void;
  /** Moves through the scale list, wrapping at the ends. */
  stepScale: (delta: number) => void;
  stepRoot: (delta: number) => void;
  /** Changes the progression, saving it into its idea if it's one. */
  edit: (patch: Partial<Sketch>) => void;
  setChord: (bar: number, chord: ProgChord | null) => void;
  selectBar: (bar: number) => void;
}

const DEFAULT_SKETCH: Sketch = presetSketch(PRESETS.find((p) => p.name === "Night drive")!, 9, 1, "hold");

/** What you're exploring in the Lab, remembered between launches. The project key is set from here explicitly. */
export const useLab = create<LabState>()(
  persist(
    (set, get) => ({
      tool: "scales",
      pc: 9,
      scaleId: "dorian",
      sevenths: false,
      preset: "keys",
      sketch: DEFAULT_SKETCH,
      ideaId: null,
      ideas: [],
      finderSource: "sample",
      finderNotes: [],
      finderHome: null,
      tuningRef: 440,
      tuningOctave: 1,
      lit: [],
      bar: 0,
      transport: { playing: false, beat: 0, bpm: 120, at: 0 },
      set: (patch) => set(patch),
      stepScale: (delta) => {
        const i = SCALES.findIndex((x) => x.id === get().scaleId);
        set({ scaleId: SCALES[(i + delta + SCALES.length) % SCALES.length].id });
      },
      stepRoot: (delta) => set({ pc: (get().pc + delta + 12) % 12 }),
      edit: (patch) => {
        const { sketch, ideaId, ideas, bar } = get();
        const next = { ...sketch, ...patch };
        set({
          sketch: next,
          bar: Math.min(bar, next.length - 1),
          ideas: ideaId ? ideas.map((i) => (i.id === ideaId ? { ...i, sketch: next } : i)) : ideas,
        });
      },
      setChord: (bar, chord) => {
        const bars = [...get().sketch.bars];
        bars[bar] = chord;
        get().edit({ bars });
      },
      selectBar: (bar) => set({ bar: Math.max(0, Math.min(get().sketch.length - 1, bar)) }),
    }),
    {
      name: "saga-lab",
      partialize: ({ tool, pc, scaleId, sevenths, preset, sketch, ideaId, ideas, finderSource, finderNotes, finderHome, tuningRef, tuningOctave }) => ({
        tool,
        pc,
        scaleId,
        sevenths,
        preset,
        sketch,
        ideaId,
        ideas,
        finderSource,
        finderNotes,
        finderHome,
        tuningRef,
        tuningOctave,
      }),
    },
  ),
);

export function labScale(): Scale {
  return scaleById(useLab.getState().scaleId) ?? SCALES[0];
}

const timers = new Set<number>();

/** Lights each note's key while it's heard (capped, so held pad notes don't stay lit). */
function light(notes: NoteEvent[]) {
  for (const n of notes) {
    const on = window.setTimeout(() => {
      timers.delete(on);
      useLab.setState((s) => ({ lit: [...s.lit, n.note] }));
    }, (n.at ?? 0) * 1000);
    const off = window.setTimeout(() => {
      timers.delete(off);
      useLab.setState((s) => {
        const i = s.lit.indexOf(n.note);
        return i < 0 ? s : { lit: [...s.lit.slice(0, i), ...s.lit.slice(i + 1)] };
      });
    }, ((n.at ?? 0) + Math.min(n.length, 0.45)) * 1000);
    timers.add(on);
    timers.add(off);
  }
}

export function playNotes(notes: NoteEvent[]) {
  if (!notes.length) return;
  light(notes);
  api.playNotes(notes, useLab.getState().preset).catch((e) => toast(errorMessage(e)));
}

export function stopNotes() {
  timers.forEach((t) => window.clearTimeout(t));
  timers.clear();
  useLab.setState({ lit: [] });
  api.stopNotes().catch(() => {});
}

export function playNote(midi: number) {
  playNotes([{ note: midi, length: useLab.getState().preset === "pad" ? 1.2 : 0.7, velocity: 0.9 }]);
}

/** Up the scale from the root to its octave. */
export function playScale(pc: number, scale: Scale) {
  const pad = useLab.getState().preset === "pad";
  const gap = pad ? 0.24 : 0.17;
  const notes = [...scale.steps, 12].map((iv, i) => ({ note: noteFrom(pc, iv), at: i * gap, length: pad ? 0.4 : 0.22, velocity: 0.85 }));
  playNotes(notes);
}

/** A chord's notes with its root between C3 and B3, so every chord sits on the keyboard. */
export function chordNotes(pc: number, chord: Chord): number[] {
  let root = noteFrom(pc, chord.iv);
  while (root > 59) root -= 12;
  return chord.tones.map((t) => root + t);
}

export function playChord(notes: number[]) {
  const pad = useLab.getState().preset === "pad";
  playNotes(notes.map((note, i) => ({ note, at: i * 0.012, length: pad ? 2 : 1.2, velocity: 0.8 })));
}

// ---- progressions ----

/** A progression chord as it's voiced when the progression plays, bass included. */
export function auditionChord(pc: number, chord: ProgChord) {
  if (useLab.getState().transport.playing) return;
  const v = voicing(pc, chord);
  playChord([v.bass, ...v.upper]);
}

/** Puts a chord in the selected bar and moves on to the next one. */
export function placeChord(chord: ProgChord) {
  const { bar, sketch, setChord } = useLab.getState();
  setChord(bar, chord);
  auditionChord(sketch.pc, chord);
  useLab.setState({ bar: Math.min(sketch.length - 1, bar + 1) });
}

export function loadPreset(index: number) {
  const { sketch, edit } = useLab.getState();
  const next = presetSketch(PRESETS[index], sketch.pc, sketchScale(sketch).mode, sketch.rhythm);
  useLab.setState({ ideaId: null, bar: 0 });
  edit(next);
  const first = next.bars[0];
  if (first) auditionChord(next.pc, first);
}

export function setBarCount(length: number) {
  const { sketch, edit } = useLab.getState();
  if (!BAR_COUNTS.includes(length) || length === sketch.length) return;
  edit({ length, bars: length > sketch.length ? resize(sketch.bars, sketch.length, length) : sketch.bars });
}

export function clearBars() {
  useLab.getState().edit({ bars: emptyBars() });
  useLab.setState({ bar: 0 });
}

/** The name the MIDI clip and a new idea start from. */
export function sketchTitle(sketch: Sketch): string {
  return sketch.name ?? "Progression";
}

export function saveIdea(name: string) {
  const { sketch, ideas } = useLab.getState();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const idea: Idea = { id, color: COLLECTION_COLORS[ideas.length % COLLECTION_COLORS.length].hex, sketch: { ...sketch, name } };
  useLab.setState({ ideas: [...ideas, idea], ideaId: id, sketch: idea.sketch });
  toast(`Saved “${name}” in the rail`, "info");
}

export function openIdea(id: string) {
  const idea = useLab.getState().ideas.find((i) => i.id === id);
  if (!idea) return;
  useLab.setState({ ideaId: id, sketch: idea.sketch, bar: 0, tool: "progressions" });
}

export function renameIdea(id: string, name: string) {
  useLab.setState((s) => ({
    ideas: s.ideas.map((i) => (i.id === id ? { ...i, sketch: { ...i.sketch, name } } : i)),
    sketch: s.ideaId === id ? { ...s.sketch, name } : s.sketch,
  }));
}

export function duplicateIdea(id: string) {
  const idea = useLab.getState().ideas.find((i) => i.id === id);
  if (!idea) return;
  useLab.setState({ ideaId: null, sketch: idea.sketch, tool: "progressions" });
  saveIdea(`${idea.sketch.name ?? "Idea"} copy`);
}

export function deleteIdea(id: string) {
  useLab.setState((s) => ({ ideas: s.ideas.filter((i) => i.id !== id), ideaId: s.ideaId === id ? null : s.ideaId }));
}

/** A fresh, empty progression in the key being explored in Scales. */
export function newSketch() {
  const { pc, scaleId, sketch } = useLab.getState();
  useLab.setState({ ideaId: null, bar: 0, tool: "progressions", sketch: { pc, scaleId, bars: emptyBars(), length: 4, rhythm: sketch.rhythm, name: null } });
}

/** What the engine loops. */
function sequence() {
  const { sketch, preset } = useLab.getState();
  return { notes: patternNotes(sketch), beats: sketch.length * 4, bpm: useProject.getState().bpm, preset };
}

let unsubs: (() => void)[] = [];
let pushTimer: number | undefined;

function follow() {
  if (unsubs.length) return;
  // Edits, the sound and the tempo apply to the playing progression without losing its place.
  const push = () => {
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => void api.playSequence(sequence()).catch((e) => toast(errorMessage(e))), 25);
  };
  unsubs = [
    useLab.subscribe((s, p) => {
      if (s.sketch !== p.sketch || s.preset !== p.preset) push();
    }),
    useProject.subscribe((s, p) => {
      if (s.bpm !== p.bpm) push();
    }),
  ];
}

function unfollow() {
  unsubs.forEach((u) => u());
  unsubs = [];
  window.clearTimeout(pushTimer);
}

export function playProgression() {
  const { sketch } = useLab.getState();
  if (!sketch.bars.slice(0, sketch.length).some(Boolean)) {
    toast("Pick a chord for a bar first");
    return;
  }
  const bpm = useProject.getState().bpm;
  useLab.setState({ transport: { playing: true, beat: 0, bpm, at: performance.now() } });
  follow();
  api.playSequence(sequence()).catch((e) => {
    toast(errorMessage(e));
    stopProgression();
  });
}

export function stopProgression() {
  unfollow();
  useLab.setState((s) => ({ transport: { ...s.transport, playing: false } }));
  api.stopSequence().catch(() => {});
}

export function toggleProgression() {
  if (useLab.getState().transport.playing) stopProgression();
  else playProgression();
}

/** Where the engine says the progression is. It also stops it when the output device changes. */
export function onTransport(e: TransportEvent) {
  if (!e.playing) {
    unfollow();
    useLab.setState((s) => ({ transport: { ...s.transport, playing: false } }));
    return;
  }
  if (!useLab.getState().transport.playing) return;
  useLab.setState({ transport: { playing: true, beat: e.beat, bpm: e.bpm, at: performance.now() } });
}

/** Beats since the progression started, now. */
export function transportBeat(t: Transport): number {
  return t.beat + ((performance.now() - t.at) / 60_000) * t.bpm;
}

/** File name details for the MIDI clip: "124 BPM, A min". */
export function midiLabel(sketch: Sketch, bpm = useProject.getState().bpm): string {
  return `${fmtBpm(bpm)} BPM, ${keyLabel(sketch)}`;
}

export async function midiFile(): Promise<string> {
  const { sketch } = useLab.getState();
  return api.saveMidi(patternNotes(sketch), sketch.length * 4, useProject.getState().bpm, sketchTitle(sketch), midiLabel(sketch));
}
