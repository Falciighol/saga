import { ArrowDown, ArrowDownWideNarrow, ArrowUp, ChevronDown, Plus, Shuffle, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { fmtCount } from "../lib/format";
import { keyFilterLabel } from "../lib/keys";
import { clearFilters } from "../lib/actions";
import { modKey } from "../lib/platform";
import type { SortKey } from "../lib/types";
import { activeFilterCount, firstDesc, useBrowse } from "../store/browse";
import { createdLabel } from "./CreatedFilter";
import { FilterPanel, lengthLabel, tempoLabel } from "./FilterPanel";
import { openMenuBelow, type MenuItem } from "./Menu";
import { cx, Divider, IconButton } from "./ui";
import { ViewToggle } from "./ViewToggle";

/** The sort orders, grouped as the menu shows them. A directional one names its two directions in its own words. */
const SORTS: { key: SortKey; label: string; group?: string; dir?: [up: string, down: string] }[] = [
  { key: "relevance", label: "Best match" },
  { key: "bpm", label: "Tempo", group: "Sound", dir: ["Slowest first", "Fastest first"] },
  { key: "key", label: "Key (Camelot)", group: "Sound", dir: ["1A to 12B", "12B to 1A"] },
  { key: "fit", label: "Fit to the key", group: "Sound" },
  { key: "duration", label: "Length", group: "Sound", dir: ["Shortest first", "Longest first"] },
  { key: "name", label: "Name", group: "File", dir: ["A to Z", "Z to A"] },
  { key: "created", label: "Date created", group: "File", dir: ["Oldest first", "Newest first"] },
  { key: "added", label: "Recently added", group: "Your library" },
  { key: "played", label: "Recently played", group: "Your library" },
  { key: "random", label: "Shuffled", group: "" },
];

/** Which part of the filter panel each pill opens at. */
type Section = "tempo" | "length" | "audio" | "key" | "tags" | "created";

function Pill({
  label,
  value,
  removeLabel = `Remove ${label.toLowerCase()} filter`,
  onOpen,
  onRemove,
}: {
  label: string;
  value: ReactNode;
  removeLabel?: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  // The label is text2 rather than text3: on the pill's raised fill text3 falls just under 4.5:1 in the light theme.
  return (
    <span className="flex h-7 shrink-0 items-center rounded-md bg-raised text-ui">
      <button type="button" aria-haspopup="dialog" onClick={onOpen} className="flex h-7 items-center gap-1.5 rounded-l-md pr-1.5 pl-2.5 hover:bg-raised2">
        <span className="text-text2">{label}</span>
        {/* A long tag or a list of every format stops at a readable width; the full value shows on hover. */}
        <span className="max-w-48 truncate text-text">{value}</span>
      </button>
      <button type="button" data-remove aria-label={removeLabel} onClick={onRemove} className="grid h-7 w-6 place-items-center rounded-r-md text-text3 hover:bg-raised2 hover:text-text">
        <X size={12} strokeWidth={2.25} />
      </button>
    </span>
  );
}

/** Space between the bar's items (`gap-2`), counted when working out whether the pills fit beside the controls. */
const GAP = 8;
/** How far a pill row fades out at an edge that has more to show. */
const FADE = 24;

/**
 * The active filters, in a row that scrolls sideways. Its scrollbar is hidden, so an edge with more pills beyond it
 * fades out instead, and a mouse wheel scrolls it too. The padding gives focus rings room inside the scroll box.
 */
function PillRow({
  trackRef,
  onKeyboardRemove,
  children,
}: {
  trackRef: RefObject<HTMLDivElement | null>;
  /** Called with the pill's position when its × is pressed from the keyboard, before the pill goes. */
  onKeyboardRemove: (index: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<[boolean, boolean]>([false, false]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade((f) => (f[0] === start && f[1] === end ? f : [start, end]));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [trackRef]);

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Active filters"
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
      }}
      className="no-scrollbar edge-fade -mx-1 -my-1 min-w-0 scroll-px-6 overflow-x-auto px-1 py-1"
      style={{ "--fade-start": `${fade[0] ? FADE : 0}px`, "--fade-end": `${fade[1] ? FADE : 0}px` } as CSSProperties}
    >
      <div
        ref={trackRef}
        className="flex w-max items-center gap-1.5"
        onClickCapture={(e) => {
          // A click with no pointer behind it (detail 0) came from Enter or Space.
          const remove = e.detail === 0 && (e.target as Element).closest("[data-remove]");
          if (remove) onKeyboardRemove([...e.currentTarget.querySelectorAll("[data-remove]")].indexOf(remove));
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function FilterBar() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section | null>(null);
  const panelId = useId();
  const filterButton = useRef<HTMLButtonElement>(null);
  // Where focus was when the panel opened, to go back to when it's closed from the keyboard.
  const returnFocus = useRef<Element | null>(null);
  const refocusPill = useRef<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const f = useBrowse((s) => s.filters);
  const setFilters = useBrowse((s) => s.setFilters);
  const total = useBrowse((s) => s.total);
  const sort = useBrowse((s) => s.sort);
  const desc = useBrowse((s) => s.desc);
  const setSort = useBrowse((s) => s.setSort);
  const shuffle = useBrowse((s) => s.shuffle);
  const categories = useBrowse((s) => s.categories);
  const kind = useBrowse((s) => s.kind);
  const lastTotal = useRef<number | null>(null);
  if (total != null) lastTotal.current = total;
  const shownTotal = total ?? lastTotal.current;

  /** Opens the panel, scrolled to a pill's own section when a pill opened it. */
  const show = (at: Section | null = null) => {
    returnFocus.current = document.activeElement;
    setSection(at);
    setOpen(true);
  };
  // Closing from the keyboard puts focus back where it was (the Filter button, a pill, the search box, or nowhere, so
  // Space plays again). Closing with the mouse leaves focus alone: a button focused here by code would count as one
  // you tabbed to, and Space would press it instead of playing.
  const close = (fromKeyboard: boolean) => {
    setOpen(false);
    if (!fromKeyboard) return;
    const el = returnFocus.current;
    if (el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  useEffect(() => {
    const onOpen = () => {
      returnFocus.current = document.activeElement;
      setSection(null);
      setOpen(true);
    };
    window.addEventListener("saga:open-filters", onOpen);
    return () => window.removeEventListener("saga:open-filters", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // After a pill is removed from the keyboard, focus moves to the × of the pill that took its place (or the one before
  // it), and to the Filter button once none are left, instead of falling out of the bar.
  const refocus = () => {
    const i = refocusPill.current;
    if (i == null) return;
    refocusPill.current = null;
    const removes = trackRef.current?.querySelectorAll<HTMLElement>("[data-remove]") ?? [];
    (removes[Math.min(i, removes.length - 1)] ?? filterButton.current)?.focus();
  };

  const n = activeFilterCount(f);
  const current = SORTS.find((s) => s.key === sort) ?? SORTS[0];
  const pills: ReactNode[] = [];

  const tempo = tempoLabel(f);
  if (tempo)
    pills.push(
      <Pill key="bpm" label="Tempo" value={<span className="font-mono text-small">{tempo}{f.halfDouble ? " ×½×2" : ""}</span>} onOpen={() => show("tempo")} onRemove={() => setFilters({ bpmMin: null, bpmMax: null, halfDouble: false })} />,
    );
  if (f.key) pills.push(<Pill key="key" label="Key" value={keyFilterLabel(f.key)} onOpen={() => show("key")} onRemove={() => setFilters({ key: null })} />);
  const length = lengthLabel(f);
  if (length) pills.push(<Pill key="len" label="Length" value={<span className="font-mono text-small">{length}</span>} onOpen={() => show("length")} onRemove={() => setFilters({ durMin: null, durMax: null })} />);
  if (f.formats.length)
    pills.push(<Pill key="fmt" label="Format" value={f.formats.map((x) => x.toUpperCase()).join(", ")} onOpen={() => show("audio")} onRemove={() => setFilters({ formats: [] })} />);
  if (f.channels) pills.push(<Pill key="ch" label="Channels" value={f.channels === 1 ? "Mono" : "Stereo"} onOpen={() => show("audio")} onRemove={() => setFilters({ channels: null })} />);
  if (f.sampleRates.length)
    pills.push(<Pill key="sr" label="Rate" value={f.sampleRates.map((r) => `${r / 1000}k`).join(", ")} onOpen={() => show("audio")} onRemove={() => setFilters({ sampleRates: [] })} />);
  const created = createdLabel(f);
  if (created) pills.push(<Pill key="created" label="Created" value={created} onOpen={() => show("created")} onRemove={() => setFilters({ createdFrom: null, createdTo: null })} />);
  for (const t of f.tags)
    pills.push(<Pill key={`t-${t}`} label="Tag" value={t} removeLabel={`Remove tag ${t}`} onOpen={() => show("tags")} onRemove={() => setFilters({ tags: f.tags.filter((x) => x !== t) })} />);
  for (const t of f.excludeTags)
    pills.push(
      <Pill key={`x-${t}`} label="Without" value={t} removeLabel={`Stop excluding ${t}`} onOpen={() => show("tags")} onRemove={() => setFilters({ excludeTags: f.excludeTags.filter((x) => x !== t) })} />,
    );

  const sortMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [];
    let group: string | undefined;
    for (const s of SORTS) {
      if (s.group !== group) {
        items.push("separator");
        if (s.group) items.push({ label: s.group, heading: true });
        group = s.group;
      }
      items.push({
        // Ranks by how much of each sample's pitched sound falls on the key filter's notes.
        label: s.key === "fit" && !f.key ? `${s.label} (filter by a key first)` : s.label,
        checked: s.key === sort,
        radio: true,
        disabled: s.key === "fit" && !f.key,
        onSelect: () => (s.key === "random" ? shuffle() : setSort(s.key, s.key === sort ? desc : firstDesc(s.key))),
      });
    }
    if (current.dir) {
      const [up, down] = current.dir;
      items.push(
        "separator",
        { label: up, checked: !desc, radio: true, onSelect: () => setSort(sort, false) },
        { label: down, checked: desc, radio: true, onSelect: () => setSort(sort, true) },
      );
    }
    openMenuBelow(el, items, "right");
  };

  const anything = n > 0 || categories.length > 0 || kind !== "all";
  const hasPills = pills.length > 0;

  // The pills share the line with the controls while they fit, and move to a line of their own when they don't, so the
  // Filters button, Clear filters and the sort controls are never scrolled out of reach. The controls (marked data-fixed) are
  // the same width on either layout, which keeps this from flipping back and forth. It measures on every render too, so
  // a pill added on a full line moves down before it's painted.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !hasPills) {
      setStacked(false);
      refocus();
      return;
    }
    const fixed = [...bar.querySelectorAll<HTMLElement>("[data-fixed]")];
    const measure = () => {
      const track = trackRef.current;
      if (!track) return;
      const style = getComputedStyle(bar);
      const room = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - fixed.reduce((w, el) => w + el.offsetWidth + GAP, 0);
      setStacked(track.offsetWidth > room);
    };
    measure();
    refocus();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    for (const el of fixed) ro.observe(el);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => ro.disconnect();
  });

  return (
    <div ref={barRef} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <span data-fixed className="relative flex shrink-0">
        <button
          ref={filterButton}
          type="button"
          title={`Filters (${modKey}⇧F)`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close(false) : show())}
          className={cx(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 text-ui transition-colors",
            open ? "border-accent text-text" : "border-line2 text-text2 hover:text-text",
          )}
        >
          <Plus size={13} strokeWidth={2} />
          <span className="@max-[440px]:sr-only">Filters</span>
          {n > 0 && <span className="rounded bg-accent-soft px-1 font-mono text-micro text-accent-ink">{n}</span>}
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onMouseDown={() => close(false)} />
            <FilterPanel id={panelId} section={section} onClose={close} />
          </>
        )}
      </span>

      {/* The pills and Clear filters stay one element whichever line they're on, so moving lines never rebuilds them. That
          keeps focus and the scroll position, and keeps Tab order: Filters, the pills, Clear filters, then sorting. */}
      {anything && (
        <div className={cx("flex min-w-0 items-center gap-2", stacked && "order-last basis-full")}>
          {hasPills && (
            <PillRow trackRef={trackRef} onKeyboardRemove={(i) => (refocusPill.current = i)}>
              {pills}
            </PillRow>
          )}
          <button type="button" data-fixed onClick={clearFilters} className="h-7 shrink-0 px-1.5 text-ui whitespace-nowrap text-text3 hover:text-text">
            Clear<span className="@max-[440px]:sr-only"> filters</span>
          </button>
        </div>
      )}

      {/* Ordering this list, then switching views: two groups, so a divider sits between them too. */}
      <div data-fixed className="ml-auto flex shrink-0 items-center gap-2">
        {/* While a new count loads, the last one stays (dimmed), so the bar doesn't shift and nothing is announced twice. */}
        <span aria-live="polite" className={cx("font-mono text-small text-text3 tabular transition-opacity @max-[400px]:hidden", total == null && "opacity-50")}>
          {shownTotal != null && (
            <>
              {fmtCount(shownTotal)}
              <span className="@max-[640px]:sr-only"> {shownTotal === 1 ? "result" : "results"}</span>
            </>
          )}
        </span>
        <Divider className="@max-[400px]:hidden" />
        <button type="button" aria-haspopup="menu" onClick={(e) => sortMenu(e.currentTarget)} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui hover:bg-raised">
          <ArrowDownWideNarrow size={15} strokeWidth={1.75} className="hidden text-text2 @max-[540px]:block" />
          <span className="text-text3 @max-[740px]:sr-only">Sort</span>
          <span className="@max-[540px]:sr-only">{current.label}</span>
          {current.dir && (
            <>
              {desc ? <ArrowDown size={12} className="text-text3 @max-[540px]:hidden" /> : <ArrowUp size={12} className="text-text3 @max-[540px]:hidden" />}
              <span className="sr-only">, {current.dir[desc ? 1 : 0]}</span>
            </>
          )}
          <ChevronDown size={12} strokeWidth={2.25} className="text-text3" />
        </button>
        {/* Not a toggle: pressing it again deals a new order, and the Sort menu leaves shuffled. */}
        <IconButton label={sort === "random" ? "Shuffle again" : "Shuffle results"} size={28} active={sort === "random"} onClick={shuffle}>
          <Shuffle size={15} strokeWidth={1.75} />
        </IconButton>
        <Divider />
        <ViewToggle />
      </div>
    </div>
  );
}
