import { Copy, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { clearFilters, copyText, count } from "../lib/actions";
import { isMac } from "../lib/platform";
import { fmtSeconds } from "../lib/format";
import { keyFilterLabel, keyFilterToken } from "../lib/keys";
import { BPM_HIST_BINS, BPM_HIST_MIN, BPM_HIST_STEP, DUR_HIST_BINS, DUR_HIST_MAX, DUR_HIST_MIN } from "../lib/types";
import { useBrowse, type AdvancedFilters } from "../store/browse";
import { KeyWheel } from "./KeyWheel";
import { Histogram, linearScale, logScale, RangeSlider } from "./RangeSlider";
import { CreatedFilter } from "./CreatedFilter";
import { useElementWidth } from "./PreviewPanel";
import { Chip, cx, SectionLabel, Segmented, Switch } from "./ui";

const BPM_MAX = BPM_HIST_MIN + BPM_HIST_BINS * BPM_HIST_STEP;
const bpmScale = linearScale(BPM_HIST_MIN, BPM_MAX);
const durScale = logScale(DUR_HIST_MIN, DUR_HIST_MAX);

const TEMPO_PRESETS: { label: string; range: [number, number] }[] = [
  { label: "Hip-hop", range: [80, 100] },
  { label: "House", range: [120, 128] },
  { label: "Techno", range: [125, 140] },
  { label: "Trap", range: [130, 150] },
  { label: "DnB", range: [165, 178] },
];

const LENGTH_PRESETS: { label: string; range: [number | null, number | null] }[] = [
  { label: "Hits < 1 s", range: [null, 1] },
  { label: "1–4 s", range: [1, 4] },
  { label: "4–16 s", range: [4, 16] },
  { label: "16 s +", range: [16, null] },
];

const FORMATS = ["wav", "aiff", "flac", "mp3", "ogg", "m4a", "caf"];
const RATES = [44100, 48000, 88200, 96000];

export function tempoLabel(f: AdvancedFilters): string | null {
  const { bpmMin: lo, bpmMax: hi } = f;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return lo === hi ? `${lo}` : `${lo}–${hi}`;
  return lo != null ? `≥ ${lo}` : `≤ ${hi}`;
}

export function lengthLabel(f: AdvancedFilters): string | null {
  const { durMin: lo, durMax: hi } = f;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return `${fmtSeconds(lo).replace(/ (s|ms|min)$/, "")}–${fmtSeconds(hi)}`;
  return lo != null ? `≥ ${fmtSeconds(lo)}` : `≤ ${fmtSeconds(hi!)}`;
}

function roundSeconds(v: number): number {
  if (v < 1) return Math.round(v * 100) / 100;
  if (v < 10) return Math.round(v * 10) / 10;
  return Math.round(v);
}

export function searchSyntax(kind: string, categories: string[], f: AdvancedFilters): string {
  const parts: string[] = [];
  if (kind !== "all") parts.push(`is:${kind}`);
  for (const c of categories) parts.push(`cat:${c.toLowerCase()}`);
  if (f.bpmMin != null || f.bpmMax != null) {
    parts.push(f.bpmMin != null && f.bpmMax != null ? `bpm:${f.bpmMin}-${f.bpmMax}` : f.bpmMin != null ? `bpm:>${f.bpmMin}` : `bpm:<${f.bpmMax}`);
  }
  if (f.key) parts.push(keyFilterToken(f.key));
  if (f.durMin != null || f.durMax != null) {
    parts.push(f.durMin != null && f.durMax != null ? `len:${f.durMin}-${f.durMax}s` : f.durMin != null ? `len:>${f.durMin}s` : `len:<${f.durMax}s`);
  }
  for (const x of f.formats) parts.push(`ext:${x}`);
  if (f.channels) parts.push(f.channels === 1 ? "is:mono" : "is:stereo");
  for (const t of f.tags) parts.push(`tag:${t}`);
  for (const t of f.excludeTags) parts.push(`-tag:${t}`);
  return parts.join("  ");
}

function toggleIn<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * The filters, in a panel under the Filters button. It takes focus when it opens, so Tab starts inside it, and closes
 * when focus leaves it. `onClose` is told whether the keyboard closed it, so focus can go back.
 */
export function FilterPanel({ id, section, onClose }: { id: string; section?: string | null; onClose: (fromKeyboard: boolean) => void }) {
  const f = useBrowse((s) => s.filters);
  const kind = useBrowse((s) => s.kind);
  const categories = useBrowse((s) => s.categories);
  const facets = useBrowse((s) => s.facets);
  const total = useBrowse((s) => s.total);
  const setFilters = useBrowse((s) => s.setFilters);
  const [tagInput, setTagInput] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  // The tempo and length graphs are drawn to the left column's width, which is fixed side by side and fills the panel
  // when the columns stack.
  const [column, columnWidth] = useElementWidth<HTMLDivElement>();
  const graphWidth = columnWidth || 380;

  // The panel ends above the window's bottom edge and scrolls inside, so Done and the search line stay in view.
  useLayoutEffect(() => {
    const fit = () => {
      const el = panel.current;
      if (el) setMaxHeight(Math.max(240, Math.floor(window.innerHeight - el.getBoundingClientRect().top - 12)));
    };
    fit();
    panel.current?.focus({ preventScroll: true });
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Opened from a pill: start at that pill's section, once the panel has its height and can scroll.
  const scrolledTo = useRef(false);
  useLayoutEffect(() => {
    if (!section || maxHeight == null || scrolledTo.current) return;
    scrolledTo.current = true;
    panel.current?.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: "nearest" });
  }, [section, maxHeight]);

  const bpmBinSelected = (i: number) => {
    const center = BPM_HIST_MIN + (i + 0.5) * BPM_HIST_STEP;
    if (f.bpmMin == null && f.bpmMax == null) return false;
    return (f.bpmMin == null || center >= f.bpmMin) && (f.bpmMax == null || center <= f.bpmMax);
  };
  const durBinSelected = (i: number) => {
    if (f.durMin == null && f.durMax == null) return false;
    const center = durScale.fromPos((i + 0.5) / DUR_HIST_BINS);
    return (f.durMin == null || center >= f.durMin) && (f.durMax == null || center <= f.durMax);
  };

  const addTag = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const exclude = raw.trim().startsWith("-");
    const tag = exclude ? t.replace(/^-+/, "") : t;
    if (!tag) return;
    if (exclude) setFilters({ excludeTags: toggleIn(f.excludeTags.filter((x) => x !== tag), tag), tags: f.tags.filter((x) => x !== tag) });
    else setFilters({ tags: f.tags.includes(tag) ? f.tags : [...f.tags, tag], excludeTags: f.excludeTags.filter((x) => x !== tag) });
  };

  const syntax = searchSyntax(kind, categories, f);
  const suggestions = (facets?.tags ?? []).filter(([t]) => !f.tags.includes(t) && !f.excludeTags.includes(t)).slice(0, 10);

  return (
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label="Filters"
      tabIndex={-1}
      style={{ maxHeight }}
      className="animate-pop absolute top-full left-0 z-40 mt-3 flex w-[832px] max-w-[calc(100cqw-2rem)] flex-col overflow-hidden rounded-2xl border border-line2 bg-panel shadow-pop"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose(true);
        }
      }}
      onBlur={(e) => {
        // Tabbing past the last control (or Shift-Tabbing out) closes it, like a menu. A blur with nowhere to go, such
        // as switching to the DAW, keeps it open.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) onClose(false);
      }}
    >
      <div className="flex min-h-0 gap-10 overflow-y-auto px-6 pt-5 pb-5 @max-[820px]:flex-col @max-[820px]:gap-6 @max-[520px]:px-4">
        <div ref={column} className="flex w-[380px] shrink-0 flex-col gap-6 @max-[820px]:w-full">
          <section data-section="tempo" className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between">
              <SectionLabel>Tempo</SectionLabel>
              <span className="font-mono text-ui tabular">{tempoLabel(f) ? `${tempoLabel(f)} BPM` : <span className="text-text3">Any</span>}</span>
            </div>
            <Histogram counts={facets?.bpmHist ?? []} width={graphWidth} height={48} isSelected={bpmBinSelected} />
            <RangeSlider
              label="Tempo"
              width={graphWidth}
              scale={bpmScale}
              round={Math.round}
              value={[f.bpmMin, f.bpmMax]}
              onChange={([lo, hi]) => setFilters({ bpmMin: lo, bpmMax: hi })}
            />
            <div className="flex justify-between font-mono text-[10.5px] text-text3">
              {[40, 85, 130, 175, 220].map((v) => (
                <span key={v}>{v}</span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {TEMPO_PRESETS.map((p) => {
                const on = f.bpmMin === p.range[0] && f.bpmMax === p.range[1];
                return (
                  <Chip key={p.label} on={on} onClick={() => setFilters(on ? { bpmMin: null, bpmMax: null } : { bpmMin: p.range[0], bpmMax: p.range[1] })}>
                    {p.label} <span className="font-mono text-micro text-text3">{p.range.join("–")}</span>
                  </Chip>
                );
              })}
            </div>
            <Switch checked={f.halfDouble} onChange={(v) => setFilters({ halfDouble: v })} label="Include half and double time" />
          </section>

          <section data-section="length" className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between">
              <SectionLabel>Length</SectionLabel>
              <span className="font-mono text-ui tabular">{lengthLabel(f) ?? <span className="text-text3">Any</span>}</span>
            </div>
            <Histogram counts={facets?.durHist ?? []} width={graphWidth} height={36} isSelected={durBinSelected} />
            <RangeSlider
              label="Length"
              width={graphWidth}
              scale={durScale}
              round={roundSeconds}
              value={[f.durMin, f.durMax]}
              onChange={([lo, hi]) => setFilters({ durMin: lo, durMax: hi })}
            />
            <div className="flex gap-1">
              {LENGTH_PRESETS.map((p) => {
                const on = f.durMin === p.range[0] && f.durMax === p.range[1];
                return (
                  <Chip key={p.label} on={on} onClick={() => setFilters(on ? { durMin: null, durMax: null } : { durMin: p.range[0], durMax: p.range[1] })}>
                    {p.label}
                  </Chip>
                );
              })}
            </div>
          </section>

          <section data-section="audio" className="flex flex-col gap-2.5">
            <SectionLabel>Audio</SectionLabel>
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-ui text-text2">Channels</span>
              <Segmented
                size="sm"
                label="Channels"
                value={f.channels ?? 0}
                onChange={(v) => setFilters({ channels: v === 0 ? null : (v as 1 | 2) })}
                options={[
                  { value: 0, label: "Any" },
                  { value: 1, label: "Mono" },
                  { value: 2, label: "Stereo" },
                ]}
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-ui text-text2">Format</span>
              <div className="flex flex-wrap gap-0">
                {FORMATS.map((x) => (
                  <Chip key={x} mono on={f.formats.includes(x)} onClick={() => setFilters({ formats: toggleIn(f.formats, x) })}>
                    {x.toUpperCase()}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-ui text-text2">Rate</span>
              <div className="flex flex-wrap gap-0.5">
                {RATES.map((r) => (
                  <Chip key={r} mono on={f.sampleRates.includes(r)} onClick={() => setFilters({ sampleRates: toggleIn(f.sampleRates, r) })}>
                    {r / 1000}k
                  </Chip>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-6 @max-[820px]:flex-none">
          <section data-section="key" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <SectionLabel>Key</SectionLabel>
              <span className="text-ui">{f.key ? keyFilterLabel(f.key) : <span className="text-text3">Any</span>}</span>
            </div>
            <div className="flex justify-center">
              <KeyWheel
                value={f.key}
                counts={facets?.keys}
                onPick={(pc, mode) => {
                  if (f.key && f.key.pc === pc && f.key.mode === mode) setFilters({ key: null });
                  else
                    setFilters({
                      key: {
                        pc,
                        mode,
                        compatible: f.key?.compatible ?? true,
                        includeUnpitched: f.key?.includeUnpitched ?? true,
                        rootInScale: f.key?.rootInScale ?? true,
                        byNotes: f.key?.byNotes ?? false,
                      },
                    });
                }}
              />
            </div>
            <div className={cx("flex flex-col gap-1.5", !f.key && "pointer-events-none opacity-45")}>
              <Switch
                checked={f.key?.compatible ?? true}
                onChange={(v) => f.key && setFilters({ key: { ...f.key, compatible: v } })}
                label={f.key?.scale?.length ? "Include keys that share the scale's notes" : "Include compatible keys"}
              />
              <Switch
                checked={f.key?.includeUnpitched ?? true}
                onChange={(v) => f.key && setFilters({ key: { ...f.key, includeUnpitched: v } })}
                label="Keep samples without a key (drums, noise)"
              />
              <Switch
                checked={(f.key?.includeUnpitched ?? true) || (f.key?.byNotes ?? false)}
                onChange={(v) => f.key && setFilters({ key: { ...f.key, byNotes: v } })}
                label="…or only those whose notes fit the scale"
                className={cx(f.key?.includeUnpitched !== false && "pointer-events-none opacity-45")}
              />
              <Switch checked={f.key?.rootInScale ?? true} onChange={(v) => f.key && setFilters({ key: { ...f.key, rootInScale: v } })} label="One-shots: root note in the scale" />
            </div>
          </section>

          <section data-section="tags" className="flex flex-col gap-2.5">
            <SectionLabel>Tags</SectionLabel>
            {(f.tags.length > 0 || f.excludeTags.length > 0) && (
              <div className="flex flex-wrap gap-1">
                {f.tags.map((t) => (
                  <span key={t} className="flex h-[26px] items-center gap-1 rounded-md bg-raised2 pr-1 pl-2.5 text-small">
                    {t}
                    <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setFilters({ tags: f.tags.filter((x) => x !== t) })} className="grid h-[18px] w-[18px] place-items-center rounded text-text3 hover:text-text">
                      <X size={11} strokeWidth={2.25} />
                    </button>
                  </span>
                ))}
                {f.excludeTags.map((t) => (
                  <span key={t} className="flex h-[26px] items-center gap-1 rounded-md border border-line2 pr-1 pl-2.5 text-small text-text2">
                    <span className="line-through">{t}</span>
                    <button type="button" aria-label={`Stop excluding ${t}`} onClick={() => setFilters({ excludeTags: f.excludeTags.filter((x) => x !== t) })} className="grid h-[18px] w-[18px] place-items-center rounded text-text3 hover:text-text">
                      <X size={11} strokeWidth={2.25} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addTag(tagInput);
                  setTagInput("");
                }
              }}
              placeholder="Add a tag — prefix with − to exclude"
              aria-label="Add tag filter"
              className="h-8 rounded-lg border border-line2 bg-raised px-2.5 text-ui text-text outline-none placeholder:text-text3 focus:border-accent"
            />
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-0.5">
                <span className="mr-1 text-small text-text3">Common here</span>
                {suggestions.map(([t, n]) => (
                  <button
                    key={t}
                    type="button"
                    title={`${count(n, "sample")} — ${isMac ? "⌥" : "Alt"}-click to exclude`}
                    onClick={(e) => addTag(e.altKey ? `-${t}` : t)}
                    className="h-6 rounded-md px-2 text-small text-text2 hover:bg-raised hover:text-text"
                  >
                    + {t}
                  </button>
                ))}
              </div>
            )}
          </section>

          <div data-section="created">
            <CreatedFilter />
          </div>
        </div>
      </div>

      <footer className="flex h-[50px] shrink-0 items-center gap-3 border-t border-line bg-bg pr-3 pl-6 @max-[520px]:pl-4">
        <SectionLabel className="shrink-0 @max-[640px]:hidden">As a search</SectionLabel>
        <code className="min-w-0 flex-1 truncate font-mono text-ui text-text">
          {syntax || <span className="text-text3">{f.createdFrom != null || f.createdTo != null ? "Date created can't be typed as a search yet" : "No filters yet"}</span>}
        </code>
        <span className="font-mono text-small text-text3 tabular">{total != null ? (total === 1 ? "1 match" : `${total.toLocaleString("en-US")} matches`) : ""}</span>
        {syntax && (
          <button type="button" onClick={() => void copyText(syntax, "Search")} className="flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-small text-text2 hover:bg-raised">
            <Copy size={14} /> Copy
          </button>
        )}
        <button type="button" onClick={clearFilters} className="h-[30px] rounded-md px-2.5 text-small whitespace-nowrap text-text3 hover:bg-raised hover:text-text">
          Clear filters
        </button>
        <button type="button" onClick={(e) => onClose(e.detail === 0)} className="h-[30px] rounded-lg bg-accent px-3.5 text-small font-semibold text-on-accent">
          Done
        </button>
      </footer>
    </div>
  );
}
