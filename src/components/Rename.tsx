import { ArrowRight, ChevronDown, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { DEFAULT_PATTERN, planRenames, PRESETS, TOKENS, type DateStyle, type KeyStyle, type RenamePattern } from "../lib/rename";
import type { SampleRow } from "../lib/types";
import { useBrowse } from "../store/browse";
import { usePrefs } from "../store/prefs";
import { toast } from "../store/toasts";
import { openMenuBelow } from "./Menu";
import { cx, IconButton, SectionLabel, Segmented, Switch } from "./ui";

interface RenameState {
  rows: SampleRow[] | null;
  open: (rows: SampleRow[]) => void;
  close: () => void;
}

export const useRename = create<RenameState>((set) => ({
  rows: null,
  open: (rows) => set({ rows }),
  close: () => set({ rows: null }),
}));

/** Most rows the preview lists; the rest are counted. */
const SHOWN = 300;

function plural(n: number, one: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;
}

/** Shows the renamed rows everywhere they're listed. */
async function refreshRows(ids: number[]) {
  try {
    useBrowse.getState().replaceRows(await api.samples(ids));
  } catch {
    /* the list refresh below catches up */
  }
  useBrowse.getState().refresh();
}

async function run(renames: { id: number; name: string }[], undo: boolean) {
  const results = await api.renameSamples(renames);
  const done = results.filter((r) => !r.error && r.from !== r.to);
  const failed = results.filter((r) => r.error);
  await refreshRows(results.map((r) => r.id));
  if (failed.length) {
    toast(`Couldn't rename ${plural(failed.length, "file")}: ${failed[0].error}`);
  }
  if (done.length) {
    const message = undo ? `Put back ${plural(done.length, "name")}` : `Renamed ${plural(done.length, "file")}`;
    toast(
      message,
      "info",
      undo
        ? undefined
        : {
            label: "Undo",
            run: () => void run(done.map((r) => ({ id: r.id, name: r.from })), true).catch((e) => toast(errorMessage(e))),
          },
    );
  }
}

export function RenameHost() {
  const rows = useRename((s) => s.rows);
  if (!rows) return null;
  return <RenameDialog key={rows.map((r) => r.id).join(",")} rows={rows} />;
}

function RenameDialog({ rows }: { rows: SampleRow[] }) {
  const close = useRename((s) => s.close);
  const saved = usePrefs((s) => s.renamePattern);
  const single = rows.length === 1;
  // One file starts from its own name, ready to type over; several start from the last pattern.
  const [p, setP] = useState<RenamePattern>(() => ({ ...DEFAULT_PATTERN, ...saved, ...(single ? { template: rows[0].name } : {}) }));
  const [dates, setDates] = useState<Map<number, number | null> | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<RenamePattern>) => setP((cur) => ({ ...cur, ...patch }));

  useEffect(() => {
    let live = true;
    api
      .fileDates(rows.map((r) => r.id))
      .then((list) => live && setDates(new Map(list.map((d) => [d.id, d.created]))))
      .catch(() => live && setDates(new Map()));
    return () => {
      live = false;
    };
  }, [rows]);

  useEffect(() => {
    requestAnimationFrame(() => input.current?.select());
  }, []);

  const plans = useMemo(() => planRenames(rows, dates ?? new Map(), p), [rows, dates, p]);
  const ready = plans.filter((x) => !x.problem && !x.unchanged);
  const problems = plans.filter((x) => x.problem).length;
  const unchanged = plans.filter((x) => x.unchanged).length;
  const uses = (token: string) => p.template.toLowerCase().includes(token);

  const insert = (token: string) => {
    const el = input.current;
    const at = el?.selectionStart ?? p.template.length;
    const end = el?.selectionEnd ?? at;
    const template = p.template.slice(0, at) + token + p.template.slice(end);
    set({ template });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const submit = async () => {
    if (!ready.length || busy) return;
    setBusy(true);
    if (!single) {
      const { template, keyStyle, relativeMajor, bpmWhole, dateStyle, skipExisting } = p;
      usePrefs.getState().set({ renamePattern: { template, keyStyle, relativeMajor, bpmWhole, dateStyle, skipExisting } });
    } else {
      // Keep the styles a single rename chose, but not its typed name.
      usePrefs.getState().set({ renamePattern: { ...(saved ?? DEFAULT_PATTERN), keyStyle: p.keyStyle, relativeMajor: p.relativeMajor, bpmWhole: p.bpmWhole, dateStyle: p.dateStyle, skipExisting: p.skipExisting } });
    }
    try {
      await run(
        ready.map((x) => ({ id: x.row.id, name: x.to })),
        false,
      );
      close();
    } catch (e) {
      toast(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-(--overlay)" onMouseDown={() => !busy && close()}>
      <form
        role="dialog"
        aria-label={single ? "Rename file" : `Rename ${rows.length} files`}
        className="animate-pop flex max-h-[86vh] w-[660px] flex-col overflow-hidden rounded-2xl border border-line2 bg-panel shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            if (!busy) close();
          }
        }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-3 pl-6">
          <h1 className="text-title font-semibold">{single ? "Rename file" : `Rename ${plural(rows.length, "file")}`}</h1>
          <IconButton label="Close" onClick={close} disabled={busy}>
            <X size={16} />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>New name</SectionLabel>
              <span className="text-micro text-text3">The extension stays as it is</span>
            </div>
            <div className="flex gap-2">
              <input
                ref={input}
                value={p.template}
                onChange={(e) => set({ template: e.target.value })}
                aria-label="New name pattern"
                spellCheck={false}
                className="h-9 min-w-0 flex-1 rounded-lg border border-line2 bg-raised px-3 font-mono text-ui text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={(e) =>
                  openMenuBelow(
                    e.currentTarget,
                    PRESETS.map((x) => ({ label: x.label, hint: x.template, checked: x.template === p.template, onSelect: () => set({ template: x.template }) })),
                    "right",
                  )
                }
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
              >
                Presets <ChevronDown size={14} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-small text-text3">Insert</span>
              {TOKENS.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  title={t.title}
                  onClick={() => insert(t.token)}
                  className={cx(
                    "flex h-6 items-center rounded-md border px-2 text-small transition-colors",
                    uses(t.token) ? "border-accent bg-accent-soft text-accent-ink" : "border-line2 text-text2 hover:bg-raised hover:text-text",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5">
            <span className={cx("text-ui", uses("{key}") ? "text-text2" : "text-text3")}>Key</span>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented<KeyStyle>
                label="Key style"
                size="sm"
                value={p.keyStyle}
                onChange={(keyStyle) => set({ keyStyle })}
                options={[
                  { value: "short", label: "F#m" },
                  { value: "compact", label: "F#min" },
                  { value: "long", label: "F# minor" },
                  { value: "camelot", label: "11A", title: "Camelot" },
                ]}
              />
              <Switch size="sm" checked={p.relativeMajor} onChange={(relativeMajor) => set({ relativeMajor })} label={<span className="text-small">Minor keys as their relative major (F#m → A)</span>} />
            </div>
            <span className={cx("text-ui", uses("{bpm}") ? "text-text2" : "text-text3")}>Tempo</span>
            <Segmented<"whole" | "exact">
              label="Tempo style"
              size="sm"
              className="justify-self-start"
              value={p.bpmWhole ? "whole" : "exact"}
              onChange={(v) => set({ bpmWhole: v === "whole" })}
              options={[
                { value: "whole", label: "124", title: "Rounded to whole beats" },
                { value: "exact", label: "123.45", title: "As stored, up to two decimals" },
              ]}
            />
            <span className={cx("text-ui", uses("{date}") ? "text-text2" : "text-text3")}>Date</span>
            <Segmented<DateStyle>
              label="Date style"
              size="sm"
              className="justify-self-start"
              value={p.dateStyle}
              onChange={(dateStyle) => set({ dateStyle })}
              options={[
                { value: "ymd", label: "2026-10-03" },
                { value: "compact", label: "20261003" },
                { value: "dmy", label: "03-10-2026" },
                { value: "mdy", label: "10-03-2026" },
              ]}
            />
          </div>
          <Switch
            checked={p.skipExisting}
            onChange={(skipExisting) => set({ skipExisting })}
            className="self-start"
            label={<span className="text-ui">Leave out a tempo or key the name already has</span>}
          />

          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>Preview</SectionLabel>
              <span className="text-micro text-text3">
                {[
                  `${plural(ready.length, "file")} to rename`,
                  unchanged ? `${unchanged.toLocaleString("en-US")} unchanged` : "",
                  problems ? plural(problems, "problem") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <div className="flex max-h-[240px] min-h-[64px] flex-col overflow-y-auto rounded-xl border border-line">
              {dates == null ? (
                <span className="animate-soft-pulse px-3 py-2.5 text-ui text-text3">Reading the files…</span>
              ) : (
                plans.slice(0, SHOWN).map((x) => (
                  <div key={x.row.id} className="grid grid-cols-[minmax(0,1fr)_14px_minmax(0,1fr)] items-center gap-2 border-b border-line px-3 py-1.5 last:border-b-0">
                    <span className="truncate font-mono text-small text-text3" title={x.row.path}>
                      {x.row.name}
                    </span>
                    <ArrowRight size={12} className="text-text3" />
                    <span className={cx("truncate font-mono text-small", x.problem ? "text-[#E5705E]" : x.unchanged ? "text-text3" : "text-text")} title={x.problem ?? undefined}>
                      {x.problem ? `${x.to || "—"} · ${x.problem}` : x.unchanged ? "Unchanged" : x.to}
                      {!x.problem && !x.unchanged && <span className="text-text3">.{x.row.ext}</span>}
                    </span>
                  </div>
                ))
              )}
              {plans.length > SHOWN && <span className="px-3 py-2 text-small text-text3">and {(plans.length - SHOWN).toLocaleString("en-US")} more</span>}
            </div>
          </div>

          <p className="flex gap-2 text-small text-pretty text-text3">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            <span>
              This renames the files on your drive. Favorites, tags and collections stay with them, and you can undo straight after. DAW projects that already use these files will look for
              them under their old names.
            </span>
          </p>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-6 py-3.5">
          <button type="button" onClick={close} disabled={busy} className="h-8 rounded-lg px-3 text-ui text-text2 hover:bg-raised disabled:opacity-40">
            Cancel
          </button>
          <button type="submit" disabled={!ready.length || busy || dates == null} className="h-8 rounded-lg bg-accent px-3.5 text-ui font-semibold text-on-accent disabled:opacity-40">
            {busy ? "Renaming…" : ready.length ? `Rename ${plural(ready.length, "file")}` : "Rename"}
          </button>
        </footer>
      </form>
    </div>
  );
}
