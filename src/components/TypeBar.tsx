import { fmtCount } from "../lib/format";
import { hasMod, modKey } from "../lib/platform";
import { useBrowse } from "../store/browse";
import { cx, Divider, Segmented } from "./ui";

const ORDER = ["Kick", "Snare", "Clap", "Hat", "Perc", "Drums", "Bass", "Synth", "Keys", "Pad", "Melody", "Vocal", "Guitar", "Strings", "Brass", "FX"];

export function TypeBar() {
  const kind = useBrowse((s) => s.kind);
  const setKind = useBrowse((s) => s.setKind);
  const categories = useBrowse((s) => s.categories);
  const toggleCategory = useBrowse((s) => s.toggleCategory);
  const facets = useBrowse((s) => s.facets);

  const counts = new Map(facets?.categories ?? []);
  const shown = ORDER.filter((c) => (counts.get(c) ?? 0) > 0 || categories.includes(c));

  const count = (n: number | undefined) =>
    n != null && <span className="font-mono text-micro font-normal text-text3 tabular">{fmtCount(n)}</span>;

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-3.5 px-4">
      <Segmented
        label="Sample type"
        value={kind}
        onChange={setKind}
        options={[
          { value: "all", label: "All" },
          { value: "oneshot", label: <>One-shots {count(facets?.oneshots)}</> },
          { value: "loop", label: <>Loops {count(facets?.loops)}</> },
        ]}
      />
      {shown.length > 0 && <Divider />}
      <div role="group" aria-label="Category" className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto">
        {shown.map((c) => {
          const on = categories.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              title={`${fmtCount(counts.get(c) ?? 0)} samples${on ? "" : ` — hold ${modKey} to combine`}`}
              onClick={(e) => toggleCategory(c, hasMod(e) || e.shiftKey)}
              className={cx(
                "h-7 shrink-0 rounded-full border px-[11px] text-ui whitespace-nowrap transition-colors",
                on ? "border-text bg-text text-bg" : "border-line2 text-text2 hover:text-text",
              )}
            >
              {c}
            </button>
          );
        })}
      </div>
    </div>
  );
}
