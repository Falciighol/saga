import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { fmtCount } from "../../lib/format";
import { camelot, keyName, projectKeyLabel } from "../../lib/keys";
import { isPlain, plainScale, relatedScales, rootName, scaleById, type Scale } from "../../lib/theory";
import type { KeyFilter, SampleRow } from "../../lib/types";
import { useBrowse } from "../../store/browse";
import { playScale, useLab } from "../../store/lab";
import { useLibrary } from "../../store/library";
import { usePlayer } from "../../store/player";
import { useProject } from "../../store/project";
import { toast } from "../../store/toasts";
import { useUi } from "../../store/ui";
import { cx, SectionLabel } from "../ui";

/** Samples in keys that fit the scale, one-shots whose root is in it, and keyless samples whose notes fit it. */
export function fitFilter(pc: number, scale: Scale): KeyFilter {
  return { pc, mode: scale.mode, compatible: true, includeUnpitched: false, rootInScale: true, scale: scale.steps, byNotes: true };
}

/** How many samples fit the scale, and the ones whose notes fit it best. */
export function useFitting(pc: number, scale: Scale) {
  const total = useLibrary((s) => s.stats?.total ?? 0);
  const [state, setState] = useState<{ count: number; rows: SampleRow[] } | null>(null);
  useEffect(() => {
    let live = true;
    api
      .query({ filters: { key: fitFilter(pc, scale) }, sort: "fit", desc: false, offset: 0, limit: 6, seed: 0 })
      .then((r) => live && setState({ count: r.total, rows: r.rows }))
      .catch((e) => live && toast(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [pc, scale, total]);
  return state;
}

/** How many samples are in each major and minor key, library-wide. */
function useKeyCounts() {
  const total = useLibrary((s) => s.stats?.total ?? 0);
  const [keys, setKeys] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    api.facets({}).then((f) => live && setKeys(f.keys)).catch(() => {});
    return () => {
      live = false;
    };
  }, [total]);
  return keys;
}

function SampleButton({ row }: { row: SampleRow }) {
  const playing = usePlayer((s) => s.id === row.id && (s.status === "playing" || s.status === "loading"));
  return (
    <button
      type="button"
      onClick={() => usePlayer.getState().toggle(row)}
      className="flex h-10 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-raised"
    >
      <span className={cx("grid h-6 w-6 shrink-0 place-items-center", playing ? "text-accent-ink" : "text-text3")}>
        {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium">{row.name}</span>
        <span className="truncate text-micro text-text3">
          {row.pack}
          {row.kind === "loop" && row.bpm ? ` · ${Math.round(row.bpm)} BPM` : " · one-shot"}
        </span>
      </span>
      {row.key ? (
        <span className="shrink-0 font-mono text-small text-text2">{row.key}</span>
      ) : (
        <span className="shrink-0 text-micro text-text3" title="No key in its name or tags; the notes Saga heard in it fit the scale">
          by its notes
        </span>
      )}
    </button>
  );
}

/** Opens the list filtered to what fits the scale, the best fits first. */
export function showFitting(pc: number, scale: Scale) {
  const browse = useBrowse.getState();
  browse.setFilters({ key: fitFilter(pc, scale) });
  browse.setSort("fit");
  useUi.getState().setView("list");
}

/** Makes the scale the project key, or opens the list filtered to what fits it. */
export function KeyActions({ pc, scale }: { pc: number; scale: Scale }) {
  const project = useProject((s) => s.key);
  const setProject = useProject((s) => s.set);
  const isProject = project != null && project.pc === pc && (scaleById(project.scale) ?? plainScale(project.mode)).id === scale.id;
  const q = scale.mode;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Project key</SectionLabel>
        <span className="truncate text-small text-text3">{project ? projectKeyLabel(project) : "None"}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={isProject}
          onClick={() => {
            setProject({ key: { pc, mode: q, scale: isPlain(scale) ? null : scale.id } });
            toast(`Project key set to ${rootName(pc, q)} ${scale.name}`);
          }}
          className={cx(
            "h-8 rounded-lg px-3 text-ui font-semibold transition-colors",
            isProject ? "border border-accent bg-accent-soft font-medium text-accent-ink" : "bg-accent text-on-accent hover:brightness-105",
          )}
        >
          {isProject ? "Is the project key" : "Set as project key"}
        </button>
        <button
          type="button"
          onClick={() => {
            showFitting(pc, scale);
          }}
          title="Open the list filtered to samples in keys that fit, one-shots whose root is in the scale and samples without a key whose notes fit, best fit first"
          className="h-8 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
        >
          Show samples that fit
        </button>
      </div>
    </section>
  );
}

export function LabSide({ pc, scale }: { pc: number; scale: Scale }) {
  const hasSources = useLibrary((s) => s.sources.length > 0);
  const fitting = useFitting(pc, scale);
  const counts = useKeyCounts();
  const q = scale.mode;
  const moves: { label: string; note?: string; pc: number; mode: 0 | 1 }[] = [
    { label: "Same key", pc, mode: q },
    { label: "Up a fifth", note: "smooth", pc: (pc + 7) % 12, mode: q },
    { label: "Down a fifth", note: "smooth", pc: (pc + 5) % 12, mode: q },
    q === 1 ? { label: "Relative major", note: "brighter", pc: (pc + 3) % 12, mode: 0 } : { label: "Relative minor", note: "darker", pc: (pc + 9) % 12, mode: 1 },
    { label: "Up two", note: "energy boost", pc: (pc + 2) % 12, mode: q },
    { label: "Up a semitone", note: "key change lift", pc: (pc + 1) % 12, mode: q },
  ];
  const related = relatedScales(pc, scale).slice(0, 7);

  return (
    <aside
      aria-label="Scale details"
      className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] content-start gap-x-8 gap-y-5 border-t border-line bg-panel px-5 py-4 @min-[860px]/lab:flex @min-[860px]/lab:w-[280px] @min-[860px]/lab:flex-col @min-[860px]/lab:overflow-y-auto @min-[860px]/lab:border-t-0 @min-[860px]/lab:border-l @min-[860px]/lab:px-4"
    >
      <KeyActions pc={pc} scale={scale} />

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>In your library</SectionLabel>
          {fitting && <span className="font-mono text-small text-text2 tabular">{fmtCount(fitting.count)} fit</span>}
        </div>
        {!hasSources ? (
          <p className="text-ui text-text3">Add sample folders to see which of your samples fit this scale.</p>
        ) : fitting && fitting.rows.length === 0 ? (
          <p className="text-ui text-text3">Nothing in your library is in a key that fits yet. Tempo and key detection may still be running.</p>
        ) : (
          <div className="flex flex-col">{fitting?.rows.map((r) => <SampleButton key={r.id} row={r} />)}</div>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Mix-friendly keys</SectionLabel>
          <span className="text-micro text-text3">Camelot moves</span>
        </div>
        <div className="flex flex-col">
          {moves.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={() => {
                const next = plainScale(m.mode);
                useLab.getState().set({ pc: m.pc, scaleId: next.id });
                playScale(m.pc, next);
              }}
              className="flex min-h-[30px] items-center gap-2 rounded-md px-2 text-left text-ui text-text2 hover:bg-raised hover:text-text"
            >
              <span className="min-w-0 flex-1 truncate">
                {m.label}
                {m.note && <span className="text-text3"> · {m.note}</span>}
              </span>
              <span className="shrink-0 font-mono text-small text-text3">
                {keyName(m.pc, m.mode)} {camelot(m.pc, m.mode)}
                {counts && <span className="ml-1.5 inline-block min-w-7 text-right text-text2 tabular">{fmtCount(counts[m.pc * 2 + m.mode])}</span>}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <SectionLabel>Related scales</SectionLabel>
          <span className="text-micro text-text3">One note away</span>
        </div>
        {related.length ? (
          <div className="flex flex-col">
            {related.map((r) => (
              <button
                key={`${r.pc}${r.scale.id}`}
                type="button"
                onClick={() => {
                  useLab.getState().set({ pc: r.pc, scaleId: r.scale.id });
                  playScale(r.pc, r.scale);
                }}
                className="flex min-h-[30px] items-center gap-2 rounded-md px-2 text-left text-ui text-text2 hover:bg-raised hover:text-text"
              >
                <span className="min-w-0 flex-1 truncate">
                  {rootName(r.pc, r.scale.mode)} {r.scale.name}
                </span>
                <span className="shrink-0 font-mono text-micro text-text3">{r.why}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-ui text-text3">No scale of the same size is one note away.</p>
        )}
      </section>
    </aside>
  );
}
