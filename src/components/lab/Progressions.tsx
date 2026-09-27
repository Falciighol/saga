import { ChevronDown, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dragOut } from "../../lib/actions";
import { errorMessage } from "../../lib/api";
import { projectKeyLabel } from "../../lib/keys";
import {
  BAR_COUNTS,
  chordOf,
  keyLabel,
  patternNotes,
  PRESETS,
  sameChord,
  sketchScale,
  suggestions,
  type ProgChord,
  type Rhythm,
  type Sketch,
} from "../../lib/progressions";
import { borrowedChords, FAMILIES, inScale, plainScale, romanNumeral, rootName, scaleById, scaleChords, scaleLabel, SCALES } from "../../lib/theory";
import {
  auditionChord,
  clearBars,
  duplicateIdea,
  loadPreset,
  midiFile,
  midiLabel,
  placeChord,
  renameIdea,
  saveIdea,
  setBarCount,
  sketchTitle,
  toggleProgression,
  transportBeat,
  useLab,
  type Transport,
} from "../../store/lab";
import { useProject } from "../../store/project";
import { toast } from "../../store/toasts";
import { openContextMenu, openMenuBelow, type MenuItem } from "../Menu";
import { GripIcon, MetronomeIcon } from "../PreviewPanel";
import { usePrompt } from "../Prompt";
import { cx, Divider, IconButton, Segmented, SectionLabel } from "../ui";
import { ViewToggle } from "../ViewToggle";
import { ChordCard, FUNCTION_COLORS, FUNCTION_LABELS, FunctionDot } from "./ChordCard";
import { KeyActions } from "./LabSide";

const RHYTHMS: { value: Rhythm; label: string; title: string }[] = [
  { value: "hold", label: "Hold", title: "One chord a bar" },
  { value: "pulse", label: "Pulse", title: "The chord on every beat" },
  { value: "arp", label: "Arp", title: "The chord's notes in eighths, up and back down" },
];

/** Beats since the progression started, updated every frame while it plays (null when stopped). */
function useBeat(transport: Transport, onFrame: (beat: number | null) => void) {
  const frame = useRef(onFrame);
  frame.current = onFrame;
  useEffect(() => {
    if (!transport.playing) {
      frame.current(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      frame.current(transportBeat(transport));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [transport]);
}

/** The bar being heard, or -1 (also while waiting for a loop's next bar). Re-renders only when it changes. */
function usePlayingBar(length: number): number {
  const transport = useLab((s) => s.transport);
  const [bar, setBar] = useState(-1);
  // The engine starts a few milliseconds ahead; that isn't worth showing as a wait.
  useBeat(transport, (b) => setBar(b == null || b < -0.25 ? -1 : Math.floor(Math.max(0, b) / 4) % length));
  return bar;
}

function setKey(pc: number, scaleId: string) {
  const { edit, sketch, bar } = useLab.getState();
  edit({ pc, scaleId });
  const ch = sketch.bars[bar] ?? sketch.bars.find(Boolean);
  if (ch) auditionChord(pc, ch);
}

function keyMenu(el: HTMLElement) {
  const { sketch, pc, scaleId } = useLab.getState();
  const scale = sketchScale(sketch);
  const project = useProject.getState().key;
  const items: MenuItem[] = [
    {
      label: "Root",
      submenu: Array.from({ length: 12 }, (_, n) => ({ label: rootName(n, scale.mode), checked: n === sketch.pc, onSelect: () => setKey(n, sketch.scaleId) })),
    },
    {
      label: "Scale",
      submenu: FAMILIES.map((f) => ({
        label: f.label,
        submenu: SCALES.filter((x) => x.family === f.id).map((x) => ({ label: x.name, checked: x.id === sketch.scaleId, onSelect: () => setKey(sketch.pc, x.id) })),
      })),
    },
    "separator",
  ];
  const explored = scaleById(scaleId) ?? SCALES[0];
  if (pc !== sketch.pc || scaleId !== sketch.scaleId) items.push({ label: `Use ${scaleLabel(pc, explored)} from Scales`, onSelect: () => setKey(pc, scaleId) });
  if (project) {
    const ps = scaleById(project.scale) ?? plainScale(project.mode);
    if (project.pc !== sketch.pc || ps.id !== sketch.scaleId) items.push({ label: `Use the project key, ${projectKeyLabel(project)}`, onSelect: () => setKey(project.pc, ps.id) });
  }
  items.push({ label: "Explore this key in Scales", onSelect: () => useLab.getState().set({ pc: sketch.pc, scaleId: sketch.scaleId, tool: "scales" }) });
  openMenuBelow(el, items);
}

function barMenu(e: React.MouseEvent, i: number) {
  const { sketch, setChord, selectBar } = useLab.getState();
  const ch = sketch.bars[i];
  selectBar(i);
  openContextMenu(e, [
    { label: "Clear bar", hint: "⌫", disabled: !ch, onSelect: () => setChord(i, null) },
    { label: "Repeat in the next bar", disabled: !ch || i + 1 >= sketch.length, onSelect: () => setChord(i + 1, ch) },
    "separator",
    { label: "Clear all bars", onSelect: clearBars },
  ]);
}

function BarSlot({ sketch, i, selected, now }: { sketch: Sketch; i: number; selected: boolean; now: boolean }) {
  const ch = sketch.bars[i];
  const info = ch ? chordOf(sketch, ch) : null;
  const borrowed = info != null && !inScale(sketchScale(sketch), info);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Bar ${i + 1}: ${info ? info.name : "empty"}`}
      onClick={() => {
        useLab.getState().selectBar(i);
        if (ch) auditionChord(sketch.pc, ch);
      }}
      onContextMenu={(e) => barMenu(e, i)}
      className={cx(
        "flex min-h-[104px] min-w-0 flex-col gap-0.5 rounded-[10px] border px-3 pt-2.5 pb-2 text-left transition-colors",
        !info && "items-center justify-center border-dashed text-text3",
        selected ? "border-text3 bg-raised" : "bg-panel hover:border-text3",
        now ? "border-accent shadow-[inset_0_0_0_1px_var(--accent)]" : !selected && "border-line2",
      )}
    >
      {info ? (
        <>
          <span className="truncate font-mono text-[10.5px] text-text3">
            BAR {i + 1}
            {borrowed && " · borrowed"}
          </span>
          <span className="text-[22px] leading-tight font-semibold tracking-[-0.02em]">{info.roman}</span>
          <span className="truncate font-mono text-[12.5px] text-text2">{info.name}</span>
          <span
            className="mt-auto flex h-5 items-center gap-1.5 self-start rounded-[5px] px-1.5 text-[11px]"
            style={{ background: `color-mix(in srgb, ${FUNCTION_COLORS[info.fn]} 14%, transparent)`, color: FUNCTION_COLORS[info.fn] }}
          >
            <FunctionDot fn={info.fn} />
            {FUNCTION_LABELS[info.fn]}
          </span>
        </>
      ) : (
        <span className="text-center text-small">
          Bar {i + 1}
          <br />
          {selected ? "pick a chord below" : "empty"}
        </span>
      )}
    </button>
  );
}

const ROLL_H = 132;
/** Bass notes sit below C3 and chords above F3 (see `voicing`). */
const BASS_TOP = 48;

function Playhead({ beats }: { beats: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const transport = useLab((s) => s.transport);
  useBeat(transport, (b) => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = b == null || b < 0 ? "0" : "0.55";
    if (b != null) el.style.left = `${(((b % beats) + beats) % beats) / beats * 100}%`;
  });
  return <div ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-text" style={{ opacity: 0 }} />;
}

/** What plays, bar by bar: the bass in grey, the chord in the accent colour. */
function PianoRoll({ sketch }: { sketch: Sketch }) {
  const notes = patternNotes(sketch);
  const beats = sketch.length * 4;
  if (!notes.length) {
    return (
      <div className="grid place-items-center rounded-[10px] border border-line bg-panel text-small text-text3" style={{ height: ROLL_H }}>
        The notes appear here as you fill the bars.
      </div>
    );
  }
  const lo = Math.min(...notes.map((n) => n.note)) - 2;
  const hi = Math.max(...notes.map((n) => n.note)) + 2;
  const row = ROLL_H / (hi - lo);
  return (
    <div role="img" aria-label={`${notes.length} notes over ${sketch.length} bars`} className="relative overflow-hidden rounded-[10px] border border-line bg-panel" style={{ height: ROLL_H }}>
      {Array.from({ length: hi - lo }, (_, k) => lo + k)
        .filter((m) => m % 12 === 0)
        .map((m) => (
          <i key={m} className="absolute inset-x-0 h-px bg-line" style={{ top: (hi - m) * row }} />
        ))}
      {Array.from({ length: sketch.length - 1 }, (_, b) => (
        <i key={b} className="absolute inset-y-0 w-px bg-line2" style={{ left: `${((b + 1) * 4 * 100) / beats}%` }} />
      ))}
      {notes.map((n, k) => (
        <i
          key={k}
          className={cx("absolute rounded-[2px]", n.note < BASS_TOP ? "bg-text3" : "bg-accent opacity-85")}
          style={{
            top: (hi - n.note) * row - row / 2,
            height: Math.max(3, row - 1),
            left: `calc(${(n.start / beats) * 100}% + 1px)`,
            width: `calc(${(n.length / beats) * 100}% - 2px)`,
          }}
        />
      ))}
      <Playhead beats={beats} />
    </div>
  );
}

function MidiTile({ sketch }: { sketch: Sketch }) {
  const bpm = useProject((s) => s.bpm);
  const empty = !sketch.bars.slice(0, sketch.length).some(Boolean);
  const file = `${sketchTitle(sketch)} (${midiLabel(sketch, bpm)}).mid`;
  return (
    <div
      draggable={!empty}
      role="button"
      tabIndex={-1}
      aria-label={`Drag into your DAW as MIDI: ${file}`}
      title={empty ? "Fill a bar first" : "Drag into your DAW. The clip is saved in Music › Saga › Renders."}
      onDragStart={(e) => {
        e.preventDefault();
        midiFile()
          .then((path) => dragOut([path]))
          .catch((err) => toast(`Couldn't write the MIDI clip: ${errorMessage(err)}`));
      }}
      className={cx(
        "flex h-[64px] shrink-0 items-center gap-2.5 rounded-lg border border-dashed border-accent-wave bg-accent-soft pr-3.5 pl-2.5",
        empty ? "cursor-not-allowed opacity-50" : "cursor-grab active:cursor-grabbing",
      )}
    >
      <GripIcon className="shrink-0 fill-accent-ink" />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="text-ui font-semibold">Drag MIDI to DAW</span>
        <span className="truncate font-mono text-[10.5px] text-text3">{file}</span>
      </span>
    </div>
  );
}

function askName(title: string, initial: string, confirm: string, onSubmit: (name: string) => void) {
  usePrompt.getState().ask({ title, placeholder: "e.g. Night drive chorus", initial, confirm, onSubmit });
}

function IdeaSection({ sketch }: { sketch: Sketch }) {
  const ideaId = useLab((s) => s.ideaId);
  const idea = useLab((s) => s.ideas.find((i) => i.id === s.ideaId));
  if (ideaId && idea) {
    return (
      <section className="flex flex-col gap-2">
        <SectionLabel>Saved idea</SectionLabel>
        <p className="flex items-center gap-2 text-ui text-text2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: idea.color }} />
          <span className="min-w-0 truncate">
            <span className="font-medium text-text">{sketch.name}</span> · changes save as you go
          </span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => askName("Rename idea", sketch.name ?? "", "Rename", (n) => renameIdea(ideaId, n))}
            className="h-8 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => duplicateIdea(ideaId)}
            title="Keep this one as it is and carry on in a copy"
            className="h-8 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
          >
            Save a copy
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Keep it</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => askName("Save progression", sketch.name ?? "", "Save", saveIdea)}
          className="h-8 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
        >
          Save idea…
        </button>
        <span className="text-micro text-text3">Saved ideas sit in the rail.</span>
      </div>
    </section>
  );
}

function ProgressionSide({ sketch }: { sketch: Sketch }) {
  const ideaId = useLab((s) => s.ideaId);
  return (
    <aside
      aria-label="Progression details"
      className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] content-start gap-x-8 gap-y-5 border-t border-line bg-panel px-5 py-4 @min-[860px]/lab:flex @min-[860px]/lab:w-[280px] @min-[860px]/lab:flex-col @min-[860px]/lab:overflow-y-auto @min-[860px]/lab:border-t-0 @min-[860px]/lab:border-l @min-[860px]/lab:px-4"
    >
      <MidiTile sketch={sketch} />
      <IdeaSection sketch={sketch} />
      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Presets</SectionLabel>
          <span className="text-micro text-text3">In this key</span>
        </div>
        <div className="flex flex-col">
          {PRESETS.map((p, i) => {
            const steps = (scaleById(p.scaleId) ?? SCALES[0]).steps;
            const on = !ideaId && sketch.name === p.name;
            return (
              <button
                key={p.name}
                type="button"
                aria-pressed={on}
                onClick={() => loadPreset(i)}
                className={cx("flex min-h-[34px] items-center gap-2 rounded-md px-2 text-left", on ? "bg-raised2 text-text" : "text-text2 hover:bg-raised hover:text-text")}
              >
                <span className="min-w-0 flex-1 truncate text-ui">{p.name}</span>
                <span className="shrink-0 font-mono text-micro text-text3">{p.chords.map((c) => romanNumeral(c.iv, c.quality, steps)).join(" ")}</span>
              </button>
            );
          })}
        </div>
      </section>
      <KeyActions pc={sketch.pc} scale={sketchScale(sketch)} />
    </aside>
  );
}

export function Progressions() {
  const sketch = useLab((s) => s.sketch);
  const bar = useLab((s) => s.bar);
  const sevenths = useLab((s) => s.sevenths);
  const transport = useLab((s) => s.transport);
  const set = useLab((s) => s.set);
  const edit = useLab((s) => s.edit);
  const projectBpm = useProject((s) => s.bpm);
  const click = useProject((s) => s.click);
  const playingBar = usePlayingBar(sketch.length);
  const scale = sketchScale(sketch);
  const palette = scaleChords(sketch.pc, scale, sevenths);
  const borrowed = borrowedChords(sketch.pc, scale);
  const selected = sketch.bars[bar] ?? null;
  const prev = bar > 0 ? sketch.bars[bar - 1] : null;
  const next = suggestions(sketch, prev, sevenths);
  const place = (c: ProgChord) => placeChord({ iv: c.iv, quality: c.quality });
  const following = transport.playing && Math.abs(transport.bpm - projectBpm) > 0.05;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-4">
        <button
          type="button"
          onClick={(e) => keyMenu(e.currentTarget)}
          title="Key of the progression"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line2 pr-2 pl-3 text-ui font-medium hover:bg-raised"
        >
          {keyLabel(sketch)}
          <ChevronDown size={14} className="text-text3" />
        </button>
        <span className="truncate text-small text-text3 @max-[900px]:hidden">Chords follow the key; changing it transposes them</span>
        <div className="flex-1" />
        <Segmented size="sm" label="Rhythm" value={sketch.rhythm} onChange={(v) => edit({ rhythm: v })} options={RHYTHMS} />
        <Segmented
          size="sm"
          label="Bars"
          value={sketch.length}
          onChange={setBarCount}
          options={BAR_COUNTS.map((n) => ({ value: n, label: `${n} bars` }))}
          className="@max-[760px]:hidden"
        />
        <IconButton label="Metronome click" size={30} active={click} aria-pressed={click} onClick={() => useProject.getState().set({ click: !click })}>
          <MetronomeIcon />
        </IconButton>
        <button
          type="button"
          onClick={toggleProgression}
          title="Play or stop the progression (Space)"
          className="flex h-8 min-w-[84px] items-center justify-center gap-2 rounded-lg bg-accent px-3 text-ui font-semibold text-on-accent hover:brightness-105"
        >
          {transport.playing ? <Square size={11} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
          {transport.playing ? "Stop" : "Play"}
        </button>
        <Divider />
        <ViewToggle />
      </div>

      <div className="@container/lab min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col @min-[860px]/lab:h-full @min-[860px]/lab:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 py-4 @min-[860px]/lab:overflow-y-auto">
            <div className="flex items-baseline justify-between gap-2">
              <SectionLabel>
                {sketch.length} bars at {Math.round((transport.playing ? transport.bpm : projectBpm) * 10) / 10} BPM
              </SectionLabel>
              <span className="truncate text-micro text-text3">
                {transport.playing && playingBar < 0
                  ? "Starts on the playing loop's next bar"
                  : following
                    ? "Following the tempo of the playing loop"
                    : "Pick a bar, then a chord below · right-click a bar for more"}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {Array.from({ length: sketch.length }, (_, i) => (
                <BarSlot key={i} sketch={sketch} i={i} selected={i === bar} now={i === playingBar} />
              ))}
            </div>
            <PianoRoll sketch={sketch} />

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <SectionLabel>Next chord for bar {bar + 1}</SectionLabel>
                <span className="text-micro text-text3">{prev ? `After ${chordOf(sketch, prev).roman}` : "Opening chord"}</span>
              </div>
              {next.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {next.map((c) => (
                    <button
                      key={`${c.iv}${c.quality}`}
                      type="button"
                      aria-pressed={sameChord(selected, c)}
                      onClick={() => place(c)}
                      className={cx(
                        "flex min-w-[76px] flex-col gap-px rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                        sameChord(selected, c) ? "border-accent bg-accent-soft" : "border-line2 hover:border-text3 hover:bg-raised",
                      )}
                    >
                      <b className="text-[14px] font-semibold">{c.roman}</b>
                      <span className="font-mono text-micro text-text2">{c.name}</span>
                      <span className="text-[10.5px] text-text3">{c.why}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-ui text-text3">No chord in this scale leads on from here; try the borrowed ones.</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <SectionLabel>In the scale</SectionLabel>
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
              </div>
              {palette.length ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
                  {palette.map((c) => (
                    <ChordCard key={`${c.iv}${c.quality}`} chord={c} pressed={sameChord(selected, c)} onClick={() => place(c)} />
                  ))}
                </div>
              ) : (
                <p className="text-ui text-text3">No three-note chord fits inside this scale; try a borrowed one, or another scale from the key menu.</p>
              )}
            </div>

            {borrowed.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <SectionLabel>Borrowed</SectionLabel>
                  <span className="text-micro text-text3">From outside the scale, for colour</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
                  {borrowed.map((c) => (
                    <ChordCard key={`${c.iv}${c.quality}`} chord={c} note={c.source} pressed={sameChord(selected, c)} onClick={() => place(c)} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <ProgressionSide sketch={sketch} />
        </div>
      </div>
    </div>
  );
}
