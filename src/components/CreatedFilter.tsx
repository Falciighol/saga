import { fmtDate } from "../lib/format";
import { useBrowse, type AdvancedFilters } from "../store/browse";
import { Chip, SectionLabel } from "./ui";

const DAY = 86_400;

/** Local midnight at the start of this date, in seconds. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
}

/** Quick ranges, counted back from today when picked. */
const PRESETS: { label: string; from: () => number }[] = [
  { label: "Today", from: () => startOfDay(new Date()) },
  { label: "Last 7 days", from: () => startOfDay(new Date(Date.now() - 6 * DAY * 1000)) },
  { label: "Last 30 days", from: () => startOfDay(new Date(Date.now() - 29 * DAY * 1000)) },
  { label: "This year", from: () => new Date(new Date().getFullYear(), 0, 1).getTime() / 1000 },
];

function presetOn(f: Pick<AdvancedFilters, "createdFrom" | "createdTo">): string | null {
  if (f.createdFrom == null || f.createdTo != null) return null;
  return PRESETS.find((p) => p.from() === f.createdFrom)?.label ?? null;
}

/** "2026-10-03" from an `<input type="date">` as local midnight in seconds, or null when empty. */
function fromInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000 : null;
}

/** What the date filter shows as a pill: a quick range's name, or the days it covers. */
export function createdLabel(f: Pick<AdvancedFilters, "createdFrom" | "createdTo">): string | null {
  const { createdFrom: from, createdTo: to } = f;
  if (from == null && to == null) return null;
  const preset = presetOn(f);
  if (preset) return preset;
  // The stored end is the start of the day after the last one included.
  const last = to == null ? null : fmtDate(to - DAY);
  if (from != null && last != null) return from === to! - DAY ? fmtDate(from) : `${fmtDate(from)} – ${last}`;
  return from != null ? `Since ${fmtDate(from)}` : `Until ${last}`;
}

/** The filter panel's Date created section: quick ranges and a from/to pair of days. */
export function CreatedFilter() {
  const from = useBrowse((s) => s.filters.createdFrom);
  const to = useBrowse((s) => s.filters.createdTo);
  const setFilters = useBrowse((s) => s.setFilters);
  const preset = presetOn({ createdFrom: from, createdTo: to });
  const input = "h-7 rounded-md border border-line2 bg-raised px-2 font-mono text-small text-text tabular outline-none focus:border-accent";

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <SectionLabel>Date created</SectionLabel>
        <span className="text-ui">{createdLabel({ createdFrom: from, createdTo: to }) ?? <span className="text-text3">Any</span>}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => {
          const on = preset === p.label;
          return (
            <Chip key={p.label} on={on} onClick={() => setFilters(on ? { createdFrom: null, createdTo: null } : { createdFrom: p.from(), createdTo: null })}>
              {p.label}
            </Chip>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-small text-text2">
        From
        <input
          type="date"
          aria-label="Created from"
          value={from == null ? "" : fmtDate(from)}
          onChange={(e) => setFilters({ createdFrom: fromInput(e.target.value) })}
          className={input}
        />
        to
        <input
          type="date"
          aria-label="Created until"
          value={to == null ? "" : fmtDate(to - DAY)}
          onChange={(e) => {
            const day = fromInput(e.target.value);
            setFilters({ createdTo: day == null ? null : day + DAY });
          }}
          className={input}
        />
      </div>
    </section>
  );
}
