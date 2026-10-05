import { ArrowRight, ChevronDown, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { DEFAULT_PATTERN, planRenames, removeToken, usesToken, type RenamePattern } from "../lib/rename";
import { presetMenu } from "../lib/renamePresets";
import { TOKENS } from "../lib/renameTokens";
import type { SampleRow } from "../lib/types";
import { inListOrder, useBrowse } from "../store/browse";
import { useLibrary } from "../store/library";
import { usePrefs } from "../store/prefs";
import { toast } from "../store/toasts";
import { openMenuBelow } from "./Menu";
import { RenameStyles } from "./RenameStyles";
import { cx, IconButton, SectionLabel } from "./ui";

interface RenameState {
  /** The samples to rename, in the order the list shows them ({n} counts in it). */
  rows: SampleRow[] | null;
  /** The collection they were picked in, for {collection}; null anywhere else. */
  collection: string | null;
  open: (rows: SampleRow[]) => Promise<void>;
  close: () => void;
}

export const useRename = create<RenameState>((set) => ({
  rows: null,
  collection: null,
  open: async (rows) => {
    const view = useBrowse.getState().view;
    const collection = view.type === "collection" ? (useLibrary.getState().collections.find((c) => c.id === view.id)?.name ?? null) : null;
    let ordered = rows;
    try {
      ordered = await inListOrder(rows);
    } catch {
      /* numbered in the order they were picked */
    }
    set({ rows: ordered, collection });
  },
  close: () => set({ rows: null, collection: null }),
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
  const collection = useRename((s) => s.collection);
  if (!rows) return null;
  return <RenameDialog key={rows.map((r) => r.id).join(",")} rows={rows} collection={collection} />;
}

function RenameDialog({ rows, collection }: { rows: SampleRow[]; collection: string | null }) {
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

  const info = useMemo(() => ({ created: dates ?? new Map<number, number | null>(), collection }), [dates, collection]);
  const plans = useMemo(() => planRenames(rows, p, info), [rows, p, info]);
  const ready = plans.filter((x) => !x.problem && !x.unchanged);
  const problems = plans.filter((x) => x.problem).length;
  const clashes = plans.some((x) => x.problem === "Same name as another file here");
  const unchanged = plans.filter((x) => x.unchanged).length;
  const uses = (id: string) => usesToken(p.template, id);

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

  /** Puts the cursor back at the end of the name after a tag is taken out, added or the name cleared. */
  const replace = (template: string) => {
    set({ template });
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(template.length, template.length);
    });
  };

  /** Ends the name with {n}, so files that would share a name each get their own. */
  const addNumber = () => replace(`${p.template}${/[\s_\-.,]$/.test(p.template) || !p.template ? "" : " "}{n}`);

  const submit = async () => {
    if (!ready.length || busy) return;
    setBusy(true);
    // A single rename keeps the styles it chose, but not its typed name.
    const { template: _typed, ...styles } = p;
    usePrefs.getState().set({ renamePattern: single ? { ...(saved ?? DEFAULT_PATTERN), ...styles } : p });
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
        className="animate-pop flex max-h-[86vh] w-[700px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-line2 bg-panel shadow-pop"
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
                onClick={(e) => openMenuBelow(e.currentTarget, presetMenu(p, setP), "right")}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line2 px-3 text-ui text-text2 hover:bg-raised hover:text-text"
              >
                Presets <ChevronDown size={14} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-small text-text3">Insert</span>
              {TOKENS.map((t) => {
                const on = uses(t.id);
                // A token with nothing to give here can still be taken out, but not put in.
                const unavailable = on ? null : (t.unavailable?.(info) ?? null);
                return (
                  <button
                    key={t.id}
                    type="button"
                    title={unavailable ?? (on ? `${t.title}. Click again to take it out` : t.title)}
                    aria-pressed={on}
                    disabled={unavailable != null}
                    onClick={() => (on ? replace(removeToken(p.template, t.id)) : insert(`{${t.id}}`))}
                    className={cx(
                      "flex h-6 items-center rounded-md border px-2 text-small transition-colors disabled:opacity-40",
                      on ? "border-accent bg-accent-soft text-accent-ink" : "border-line2 text-text2 enabled:hover:bg-raised enabled:hover:text-text",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => replace("")}
                disabled={!p.template}
                className="ml-auto flex h-6 items-center rounded-md px-2 text-small text-text3 hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>

          <RenameStyles p={p} set={set} />

          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>Preview</SectionLabel>
              <span className="flex items-baseline gap-2 text-micro text-text3">
                {[
                  `${plural(ready.length, "file")} to rename`,
                  unchanged ? `${unchanged.toLocaleString("en-US")} unchanged` : "",
                  problems ? plural(problems, "problem") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {clashes && !uses("n") && (
                  <button type="button" onClick={addNumber} className="font-medium text-accent-ink hover:underline">
                    Add a number to tell them apart
                  </button>
                )}
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
