import { ArrowDownUp, ChevronDown, Plus, Shuffle, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { fmtCount } from "../lib/format";
import { keyFilterLabel } from "../lib/keys";
import type { SortKey } from "../lib/types";
import { activeFilterCount, firstDesc, useBrowse } from "../store/browse";
import { createdLabel } from "./CreatedFilter";
import { FilterPanel, lengthLabel, tempoLabel } from "./FilterPanel";
import { openMenuBelow, type MenuItem } from "./Menu";
import { cx, Divider, IconButton } from "./ui";
import { ViewToggle } from "./ViewToggle";

const SORTS: { key: SortKey; label: string; directional: boolean }[] = [
  { key: "relevance", label: "Best match", directional: false },
  { key: "name", label: "Name", directional: true },
  { key: "added", label: "Recently added", directional: false },
  { key: "created", label: "Date created", directional: true },
  { key: "played", label: "Recently played", directional: false },
  { key: "duration", label: "Length", directional: true },
  { key: "bpm", label: "Tempo", directional: true },
  { key: "key", label: "Key (Camelot)", directional: true },
  { key: "fit", label: "Fit to the key", directional: false },
  { key: "random", label: "Shuffled", directional: false },
];

function Pill({ label, value, onOpen, onRemove }: { label: string; value: ReactNode; onOpen: () => void; onRemove: () => void }) {
  return (
    <span className="flex h-7 shrink-0 items-center rounded-md bg-raised text-ui">
      <button type="button" onClick={onOpen} className="flex h-7 items-center gap-1.5 rounded-l-md pr-1.5 pl-2.5 hover:bg-raised2">
        <span className="text-text3">{label}</span>
        <span className="text-text">{value}</span>
      </button>
      <button type="button" aria-label={`Remove ${label.toLowerCase()} filter`} onClick={onRemove} className="grid h-7 w-6 place-items-center rounded-r-md text-text3 hover:bg-raised2 hover:text-text">
        <X size={12} strokeWidth={2.25} />
      </button>
    </span>
  );
}

export function FilterBar() {
  const [open, setOpen] = useState(false);
  const f = useBrowse((s) => s.filters);
  const setFilters = useBrowse((s) => s.setFilters);
  const clearAll = useBrowse((s) => s.clearAll);
  const total = useBrowse((s) => s.total);
  const sort = useBrowse((s) => s.sort);
  const desc = useBrowse((s) => s.desc);
  const setSort = useBrowse((s) => s.setSort);
  const shuffle = useBrowse((s) => s.shuffle);
  const categories = useBrowse((s) => s.categories);
  const kind = useBrowse((s) => s.kind);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("saga:open-filters", onOpen);
    return () => window.removeEventListener("saga:open-filters", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const n = activeFilterCount(f);
  const current = SORTS.find((s) => s.key === sort) ?? SORTS[0];
  const pills: ReactNode[] = [];
  const show = () => setOpen(true);

  const tempo = tempoLabel(f);
  if (tempo)
    pills.push(
      <Pill key="bpm" label="Tempo" value={<span className="font-mono text-small">{tempo}{f.halfDouble ? " ×½×2" : ""}</span>} onOpen={show} onRemove={() => setFilters({ bpmMin: null, bpmMax: null, halfDouble: false })} />,
    );
  if (f.key) pills.push(<Pill key="key" label="Key" value={keyFilterLabel(f.key)} onOpen={show} onRemove={() => setFilters({ key: null })} />);
  const length = lengthLabel(f);
  if (length) pills.push(<Pill key="len" label="Length" value={<span className="font-mono text-small">{length}</span>} onOpen={show} onRemove={() => setFilters({ durMin: null, durMax: null })} />);
  if (f.formats.length)
    pills.push(<Pill key="fmt" label="Format" value={f.formats.map((x) => x.toUpperCase()).join(", ")} onOpen={show} onRemove={() => setFilters({ formats: [] })} />);
  if (f.channels) pills.push(<Pill key="ch" label="Channels" value={f.channels === 1 ? "Mono" : "Stereo"} onOpen={show} onRemove={() => setFilters({ channels: null })} />);
  if (f.sampleRates.length)
    pills.push(<Pill key="sr" label="Rate" value={f.sampleRates.map((r) => `${r / 1000}k`).join(", ")} onOpen={show} onRemove={() => setFilters({ sampleRates: [] })} />);
  const created = createdLabel(f);
  if (created) pills.push(<Pill key="created" label="Created" value={created} onOpen={show} onRemove={() => setFilters({ createdFrom: null, createdTo: null })} />);
  for (const t of f.tags) pills.push(<Pill key={`t-${t}`} label="Tag" value={t} onOpen={show} onRemove={() => setFilters({ tags: f.tags.filter((x) => x !== t) })} />);
  for (const t of f.excludeTags)
    pills.push(<Pill key={`x-${t}`} label="Not" value={t} onOpen={show} onRemove={() => setFilters({ excludeTags: f.excludeTags.filter((x) => x !== t) })} />);

  const sortMenu = (el: HTMLElement) => {
    const items: MenuItem[] = SORTS.map((s) => ({
      // Ranks by how much of each sample's pitched sound falls on the key filter's notes.
      label: s.key === "fit" && !f.key ? `${s.label} (filter by a key first)` : s.label,
      checked: s.key === sort,
      disabled: s.key === "fit" && !f.key,
      onSelect: () => (s.key === "random" ? shuffle() : setSort(s.key, s.key === sort ? desc : firstDesc(s.key))),
    }));
    if (current.directional) {
      items.push("separator", { label: "Ascending", checked: !desc, onSelect: () => setSort(sort, false) }, { label: "Descending", checked: desc, onSelect: () => setSort(sort, true) });
    }
    openMenuBelow(el, items, "right");
  };

  const anything = n > 0 || categories.length > 0 || kind !== "all";

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
      <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {pills}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cx(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 text-ui transition-colors",
            open ? "border-accent text-text" : "border-line2 text-text2 hover:text-text",
          )}
        >
          <Plus size={13} strokeWidth={2} />
          <span>{n ? "Filters" : "Filter"}</span>
          {n > 0 && <span className="rounded bg-accent-soft px-1 font-mono text-micro text-accent-ink">{n}</span>}
        </button>
        {anything && (
          <button
            type="button"
            onClick={clearAll}
            className="h-7 shrink-0 px-1.5 text-ui text-text3 hover:text-text"
          >
            Reset
          </button>
        )}
      </div>
      <div className="flex-1" />
      <span className="shrink-0 font-mono text-small text-text3 tabular">{total == null ? "" : `${fmtCount(total)} ${total === 1 ? "result" : "results"}`}</span>
      <Divider />
      <button type="button" onClick={(e) => sortMenu(e.currentTarget)} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui hover:bg-raised">
        <span className="text-text3">Sort</span>
        <span>{current.label}</span>
        {current.directional && <ArrowDownUp size={12} className={cx("text-text3", desc && "rotate-180")} />}
        <ChevronDown size={12} strokeWidth={2.25} className="text-text3" />
      </button>
      <IconButton label="Shuffle results" size={28} active={sort === "random"} onClick={shuffle}>
        <Shuffle size={15} strokeWidth={1.75} />
      </IconButton>
      <ViewToggle />

      {open && (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <FilterPanel onClose={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}
