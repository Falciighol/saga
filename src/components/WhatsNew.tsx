import { ChevronRight, Info, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CHANGE_LABELS, inlineRuns, plainText, RELEASES, type Change, type Release } from "../lib/changelog";
import { useUi } from "../store/ui";
import { useUpdates } from "../store/updates";
import { useWhatsNew } from "../store/whatsNew";
import { cx, IconButton, Kbd, SectionLabel } from "./ui";

/** An entry's text with its keys as key caps and file names, search terms and key spellings in the numbers font. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {inlineRuns(text).map((r, i) =>
        r.kind === "key" ? (
          <Kbd key={i}>{r.text}</Kbd>
        ) : r.kind === "code" ? (
          <span key={i} className="font-mono text-[0.92em] text-text">
            {r.text}
          </span>
        ) : r.kind === "bold" ? (
          <span key={i} className="font-medium text-text">
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}

/** The card has room for one sentence; the dialog has the rest. */
function firstSentence(text: string): string {
  return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 new · 2 improved · 4 fixes", over every release in the list. */
function tally(releases: Release[]): string {
  const sum = (k: keyof Release["changes"]) => releases.reduce((n, r) => n + r.changes[k].length, 0);
  const parts = [sum("new") && `${sum("new")} new`, sum("improved") && `${sum("improved")} improved`, sum("fixed") && plural(sum("fixed"), "fix", "fixes")];
  return parts.filter(Boolean).join(" · ");
}

/**
 * The quiet card after Saga restarts into a new version. It sits where the restart notice does, never takes focus, and
 * waits for the full window if Saga opens as the mini player.
 */
export function WhatsNewNotice() {
  const notice = useWhatsNew((s) => s.notice);
  const current = useWhatsNew((s) => s.current);
  const unread = useWhatsNew((s) => s.unread);
  const since = useWhatsNew((s) => s.since);
  const mini = useUi((s) => s.mini);
  // The restart notice for the next version takes this spot first.
  const updateShowing = useUpdates((s) => !s.dismissed && (s.status === "ready" || s.status === "installing"));
  if (!notice || !current || mini || updateShowing) return null;

  const releases = RELEASES.filter((r) => unread.includes(r.version));
  const heads = releases.flatMap((r) => r.changes.good);
  const summary = tally(releases);
  const skipped = since && unread.length > 1 ? `${plural(unread.length, "update")} since ${since}` : null;

  return (
    <div
      role="status"
      aria-label={`What's new in Saga ${current}`}
      className="animate-pop fixed top-16 right-4 z-40 flex w-[300px] items-start gap-3 rounded-xl border border-line2 bg-panel p-3.5 shadow-pop"
    >
      <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <span className="text-body font-semibold">You're on Saga {current}</span>
          <p className="m-0 line-clamp-3 text-small text-pretty text-text2">
            {heads.length > 0 ? (
              <>
                <span className="font-medium text-text">Good to know: </span>
                {firstSentence(plainText(heads[0].text))}
              </>
            ) : (
              plainText(releases[0]?.headline ?? "")
            )}
          </p>
          {(skipped || summary) && <span className="text-small text-text3">{skipped ?? summary}</span>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => useWhatsNew.getState().later()} className="h-7 rounded-lg px-2.5 text-ui text-text2 hover:bg-raised hover:text-text">
            Later
          </button>
          <button type="button" onClick={() => useWhatsNew.getState().show()} className="h-7 rounded-lg bg-accent px-3 text-ui font-semibold text-on-accent">
            See what's new
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mounted with the other overlays, after Settings, so it opens above Settings when started from there. */
export function WhatsNewHost() {
  const open = useWhatsNew((s) => s.open);
  return open ? <WhatsNewDialog /> : null;
}

function WhatsNewDialog() {
  const current = useWhatsNew((s) => s.current);
  const unread = useWhatsNew((s) => s.unread);
  const close = useWhatsNew((s) => s.close);
  const body = useRef<HTMLDivElement>(null);
  // What the user hasn't read opens up; with nothing unread, the newest version does.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(unread.length ? unread : RELEASES.slice(0, 1).map((r) => r.version)));

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    body.current?.querySelector<HTMLElement>("[data-release] button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [close]);

  const toggle = (v: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-(--overlay)" onMouseDown={close}>
      <div
        role="dialog"
        aria-labelledby="whats-new-title"
        className="animate-pop flex max-h-[82vh] w-[min(580px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-line2 bg-panel shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-3 pl-6">
          <h1 id="whats-new-title" className="text-title font-semibold">
            What's new
          </h1>
          <IconButton label="Close What's new" onClick={close}>
            <X size={16} />
          </IconButton>
        </header>
        <div ref={body} className="overflow-y-auto px-3 pt-2 pb-4">
          {RELEASES.length === 0 && <p className="m-0 px-3 py-6 text-body text-text3">No notes yet.</p>}
          {RELEASES.map((r, i) => (
            <ReleaseNotes
              key={r.version}
              release={r}
              first={i === 0}
              open={expanded.has(r.version)}
              tag={r.version === current ? "Installed" : unread.includes(r.version) ? "New to you" : null}
              onToggle={() => toggle(r.version)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReleaseNotes({ release, first, open, tag, onToggle }: { release: Release; first: boolean; open: boolean; tag: string | null; onToggle: () => void }) {
  const { version, date, headline, changes } = release;
  const panel = `release-${version}`;
  return (
    <section data-release className={cx(!first && "border-t border-line")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
        className="group flex w-full items-start gap-2.5 rounded-lg px-3 pt-3.5 pb-3 text-left hover:bg-raised"
      >
        <ChevronRight size={14} className={cx("mt-[3px] shrink-0 text-text3 transition-transform duration-150", open && "rotate-90")} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="text-body font-semibold">Saga {version}</span>
            {tag && <span className="rounded-md bg-accent-soft px-1.5 py-px text-micro font-medium text-accent-ink">{tag}</span>}
            {date && <span className="ml-auto shrink-0 font-mono text-small text-text3 tabular">{date}</span>}
          </span>
          {!open && headline && <span className="truncate text-small text-text3">{plainText(headline)}</span>}
        </span>
      </button>
      {open && (
        <div id={panel} className="flex max-w-[64ch] flex-col gap-5 pt-0.5 pr-3 pb-5 pl-9">
          {headline && (
            <p className="m-0 text-body leading-relaxed text-pretty text-text2">
              <Rich text={headline} />
            </p>
          )}
          {changes.good.length > 0 && (
            <div className="flex gap-2.5 rounded-lg bg-accent-soft px-3 py-2.5">
              <Info size={14} className="mt-[3px] shrink-0 text-accent-ink" aria-hidden="true" />
              <div className="flex flex-col gap-1.5">
                <span className="text-small font-semibold text-accent-ink">{CHANGE_LABELS.good}</span>
                {changes.good.map((c, i) => (
                  <p key={i} className="m-0 text-ui leading-relaxed text-text">
                    <Entry change={c} />
                  </p>
                ))}
              </div>
            </div>
          )}
          {(["new", "improved"] as const).map(
            (k) =>
              changes[k].length > 0 && (
                <Group key={k} label={CHANGE_LABELS[k]}>
                  {changes[k].map((c, i) => (
                    <li key={i} className="flex flex-col gap-0.5">
                      {c.name && <span className="text-body font-medium text-text">{c.name}</span>}
                      <span className="text-ui leading-relaxed text-text2">
                        <Rich text={c.text} />
                      </span>
                    </li>
                  ))}
                </Group>
              ),
          )}
          {changes.fixed.length > 0 && (
            <Group label={CHANGE_LABELS.fixed} tight>
              {changes.fixed.map((c, i) => (
                <li key={i} className="flex gap-2 text-ui leading-relaxed text-text2">
                  <span className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-text3" aria-hidden="true" />
                  <span>
                    <Entry change={c} />
                  </span>
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
    </section>
  );
}

function Group({ label, tight, children }: { label: string; tight?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{label}</SectionLabel>
      <ul className={cx("m-0 flex list-none flex-col p-0", tight ? "gap-1.5" : "gap-3")}>{children}</ul>
    </div>
  );
}

/** A named entry reads "Name: what it does"; most fixes and notes have no name. */
function Entry({ change }: { change: Change }) {
  return (
    <>
      {change.name && <span className="font-medium text-text">{change.name}: </span>}
      <Rich text={change.text} />
    </>
  );
}
