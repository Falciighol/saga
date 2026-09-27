import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { SynthPreset } from "../../lib/api";
import { chordOf, sketchScale } from "../../lib/progressions";
import { SCALES, scaleById, scaleChords } from "../../lib/theory";
import { auditionChord, chordNotes, deleteIdea, duplicateIdea, newSketch, openIdea, playChord, renameIdea, useLab, type LabTool } from "../../store/lab";
import { openContextMenu } from "../Menu";
import { usePrompt } from "../Prompt";
import { cx, IconButton, SectionLabel } from "../ui";
import { ScaleIcon } from "../ViewToggle";
import { KeyFinder } from "./KeyFinder";
import { Progressions } from "./Progressions";
import { ScaleExplorer } from "./ScaleExplorer";
import { TempoTools } from "./TempoTools";

const PRESETS: { id: SynthPreset; label: string; hint: string }[] = [
  { id: "keys", label: "Keys", hint: "Electric piano" },
  { id: "pad", label: "Pad", hint: "Slow, soft, wide" },
  { id: "pluck", label: "Pluck", hint: "Plucked string" },
];

function ProgressionIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <rect x="3" y="5" width="4" height="14" rx="1" />
      <rect x="10" y="9" width="4" height="10" rx="1" />
      <rect x="17" y="3" width="4" height="16" rx="1" />
    </svg>
  );
}

function FinderIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </svg>
  );
}

function TempoIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6l4 18H5L9 3Z" />
      <path d="m12 15 5-8" />
    </svg>
  );
}

const TOOLS: { id: LabTool; label: string; icon: ReactNode; hint: string; about: string }[] = [
  {
    id: "scales",
    label: "Scales",
    icon: <ScaleIcon />,
    hint: "↑ ↓ scale · ← → root · Space play · Esc stop",
    about: "Scales and chords play through your output device, over any sample that's playing.",
  },
  {
    id: "progressions",
    label: "Progressions",
    icon: <ProgressionIcon />,
    hint: "Space play · ← → bar · ↑ ↓ chord · ⌫ clear · Esc stop",
    about: "Progressions loop at the project tempo, or in time with a loop that's playing.",
  },
  {
    id: "finder",
    label: "Key finder",
    icon: <FinderIcon />,
    hint: "↑ ↓ sample in the list · Space play · Esc stop",
    about: "Finds the keys and scales that fit a sample from the notes Saga heard in it, or from notes you pick.",
  },
  {
    id: "tempo",
    label: "Tempo & tuning",
    icon: <TempoIcon />,
    hint: "T tap tempo · ↑ ↓ sample in the list · Space play",
    about: "Delay times from the project tempo, and the key's frequencies for tuning kicks and 808s.",
  },
];

function RailButton({ on, onClick, onContextMenu, children }: { on: boolean; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-current={on ? "page" : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cx(
        "flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors",
        on ? "bg-raised2 text-text" : "text-text2 hover:bg-raised hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

function ideaMenu(e: React.MouseEvent, id: string) {
  const idea = useLab.getState().ideas.find((i) => i.id === id);
  if (!idea) return;
  openContextMenu(e, [
    {
      label: "Rename…",
      onSelect: () =>
        usePrompt.getState().ask({ title: "Rename idea", initial: idea.sketch.name ?? "", confirm: "Rename", onSubmit: (name) => renameIdea(id, name) }),
    },
    { label: "Duplicate", onSelect: () => duplicateIdea(id) },
    "separator",
    { label: "Delete", danger: true, onSelect: () => deleteIdea(id) },
  ]);
}

/** The Lab: tools for harmony next to the list and the map, with saved progressions in the rail. */
export function LabView() {
  const tool = useLab((s) => s.tool);
  const preset = useLab((s) => s.preset);
  const ideas = useLab((s) => s.ideas);
  const ideaId = useLab((s) => s.ideaId);
  const current = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];

  const pickPreset = (id: SynthPreset) => {
    useLab.getState().set({ preset: id });
    const { pc, scaleId, sketch, bar } = useLab.getState();
    if (tool === "progressions") {
      const ch = sketch.bars[bar] ?? sketch.bars.find(Boolean);
      if (ch) auditionChord(sketch.pc, ch);
      return;
    }
    const scale = scaleById(scaleId) ?? SCALES[0];
    const tonic = scaleChords(pc, scale, false)[0];
    if (tonic) playChord(chordNotes(pc, tonic));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <nav aria-label="Lab" className="flex w-[232px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-2.5 py-3.5">
          <div className="flex flex-col gap-px">
            <SectionLabel className="px-2.5 pb-1.5">Lab</SectionLabel>
            {TOOLS.map((t) => (
              <RailButton key={t.id} on={t.id === tool} onClick={() => useLab.getState().set({ tool: t.id })}>
                <span className="grid w-4 shrink-0 place-items-center text-text3">{t.icon}</span>
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {t.id === "scales" && <span className="font-mono text-micro text-text3 tabular">{SCALES.length}</span>}
              </RailButton>
            ))}
          </div>

          <div className="flex flex-col gap-px">
            <div className="flex items-center justify-between pr-1 pb-0.5 pl-2.5">
              <SectionLabel>Saved</SectionLabel>
              <IconButton label="New progression" size={22} onClick={newSketch}>
                <Plus size={14} />
              </IconButton>
            </div>
            {ideas.length === 0 ? (
              <p className="px-2.5 text-micro leading-snug text-text3">Save a progression to keep it here.</p>
            ) : (
              ideas.map((idea) => {
                const first = idea.sketch.bars.find(Boolean);
                return (
                  <RailButton key={idea.id} on={tool === "progressions" && idea.id === ideaId} onClick={() => openIdea(idea.id)} onContextMenu={(e) => ideaMenu(e, idea.id)}>
                    <span className="grid w-4 shrink-0 place-items-center">
                      <span className="h-2 w-2 rounded-full" style={{ background: idea.color }} />
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={first ? `${sketchScale(idea.sketch).name}, starts on ${chordOf(idea.sketch, first).name}` : undefined}>
                      {idea.sketch.name}
                    </span>
                    <span className="shrink-0 font-mono text-micro text-text3 tabular">{idea.sketch.length} bars</span>
                  </RailButton>
                );
              })
            )}
          </div>

          <div role="radiogroup" aria-label="Sound" className="flex flex-col gap-px">
            <SectionLabel className="px-2.5 pb-1.5">Sound</SectionLabel>
            {PRESETS.map((p) => {
              const on = p.id === preset;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pickPreset(p.id)}
                  className={cx(
                    "flex h-[30px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors",
                    on ? "bg-raised2 text-text" : "text-text2 hover:bg-raised hover:text-text",
                  )}
                >
                  <span className="grid w-4 shrink-0 place-items-center">
                    <span className={cx("h-2 w-2 rounded-full", on ? "bg-accent" : "border border-text3")} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  <span className="truncate text-micro text-text3">{p.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 border-t border-line px-5 pt-3 pb-3.5 text-micro text-text3">
          <span className="text-small text-text2">{current.about}</span>
          <span>{current.hint}</span>
        </div>
      </nav>
      <main className="@container flex min-w-0 flex-1 flex-col">
        {tool === "progressions" ? <Progressions /> : tool === "finder" ? <KeyFinder /> : tool === "tempo" ? <TempoTools /> : <ScaleExplorer />}
      </main>
    </div>
  );
}
