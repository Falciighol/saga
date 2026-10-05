import { getVersion } from "@tauri-apps/api/app";
import { FolderMinus, FolderOpen, FolderPen, FolderPlus, HardDrive, Heart, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { openLink, reveal, setPlayNext } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { MONO_FONTS, MONO_ORDER, SANS_FONTS, SANS_ORDER } from "../lib/fonts";
import { fmtBytes, fmtCount } from "../lib/format";
import { forgetRenders } from "../lib/renders";
import { altKey, modKey, revealLabel } from "../lib/platform";
import { SCALES } from "../lib/scale";
import { ACCENT_ORDER, ACCENTS, type ThemePref } from "../lib/theme";
import type { FileCount, RendersUsage, SavedSounds, SourceInfo } from "../lib/types";
import { useLibrary } from "../store/library";
import { DEFAULT_PREFS, usePrefs, type PrefValues } from "../store/prefs";
import { toast } from "../store/toasts";
import { useUi } from "../store/ui";
import { useUpdates, type UpdateStatus } from "../store/updates";
import { useWhatsNew } from "../store/whatsNew";
import { ExcludeFoldersDialog } from "./ExcludeFolders";
import { useConfirm } from "./Prompt";
import { chooseFolders } from "./Sidebar";
import { InstalledFontPicker, type FontList } from "./InstalledFontPicker";
import { cx, IconButton, Kbd, SectionLabel, Segmented, Switch } from "./ui";

function Row({ label, hint, block, children }: { label: string; hint?: string; block?: boolean; children: ReactNode }) {
  return (
    <div className={cx("flex py-2.5", block ? "flex-col gap-2" : "items-center justify-between gap-6")}>
      <div className="flex flex-col gap-0.5">
        <span className="text-body">{label}</span>
        {hint && <span className="text-small text-text3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** A tile per font, each drawn in its own face so the choice is visible before it's made. */
function FontChoices<T extends string>({
  label,
  value,
  fonts,
  order,
  sample,
  onChange,
}: {
  label: string;
  /** A bundled font, or anything else (an installed one) to select none. */
  value: string;
  fonts: Record<T, { label: string; title?: string; stack: string }>;
  order: T[];
  sample: string;
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-4 gap-2">
      {order.map((f) => {
        const on = value === f;
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={fonts[f].title ?? fonts[f].label}
            title={fonts[f].title}
            onClick={() => onChange(f)}
            style={{ fontFamily: fonts[f].stack }}
            className={cx(
              "flex h-[62px] flex-col items-start justify-between rounded-lg border px-3 pt-2.5 pb-2 text-left transition-colors",
              on ? "border-accent bg-accent-soft" : "border-line2 hover:bg-raised",
            )}
          >
            <span className="text-[19px] leading-none text-text">{sample}</span>
            <span className={cx("w-full truncate text-small", on ? "text-accent-ink" : "text-text2")}>{fonts[f].label}</span>
          </button>
        );
      })}
    </div>
  );
}

function updateHint(status: UpdateStatus, version: string | null, progress: number | null): string | undefined {
  switch (status) {
    case "checking":
      return "Checking for updates…";
    case "current":
      return "You're on the latest version.";
    case "downloading":
      return `Downloading Saga ${version}…${progress != null ? ` ${Math.round(progress * 100)}%` : ""}`;
    case "ready":
      return `Saga ${version} is ready. Restart to start using it.`;
    case "installing":
      return "Restarting…";
    case "error":
      return "Couldn't check for updates. Check your connection and try again.";
    default:
      return undefined;
  }
}

function UpdatesSection() {
  const autoUpdate = usePrefs((s) => s.autoUpdate);
  const { status, version, progress, error } = useUpdates();
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
  }, []);

  const ready = status === "ready" || status === "installing";
  const busy = status === "checking" || status === "downloading" || status === "installing";
  return (
    <section>
      <SectionLabel className="pb-1">Updates</SectionLabel>
      <Row label={current ? `Saga ${current}` : "Saga"} hint={updateHint(status, version, progress)}>
        <button
          type="button"
          title={status === "error" && error ? error : undefined}
          disabled={busy}
          onClick={() => void (ready ? useUpdates.getState().restart() : useUpdates.getState().check())}
          className={cx(
            "h-8 shrink-0 rounded-lg px-3 text-ui disabled:opacity-50",
            ready ? "bg-accent font-semibold text-on-accent" : "border border-line2 bg-raised text-text hover:bg-raised2",
          )}
        >
          {ready ? "Restart to update" : "Check for updates"}
        </button>
      </Row>
      <Row label="Check automatically" hint="Looks for a new version when Saga opens and downloads it in the background. Nothing installs until you restart.">
        <Switch checked={autoUpdate} onChange={(v) => usePrefs.getState().set({ autoUpdate: v })} />
      </Row>
      <Row label="What's new" hint="What changed in each version, newest first.">
        <button
          type="button"
          onClick={() => useWhatsNew.getState().show()}
          className="h-8 shrink-0 rounded-lg border border-line2 bg-raised px-3 text-ui text-text hover:bg-raised2"
        >
          Open
        </button>
      </Row>
    </section>
  );
}

const DONATE = [
  { label: "Gumroad", url: "https://falcighol.gumroad.com/l/qihzlk" },
  { label: "PayPal", url: "https://www.paypal.com/donate/?hosted_button_id=L5TFM8QRVZY7Y" },
];

function SupportSection() {
  return (
    <section>
      <SectionLabel className="pb-1">Support Saga</SectionLabel>
      <Row label="Saga is free" hint="If it's earned a place in your workflow, a donation helps keep it going.">
        <div className="flex shrink-0 gap-2">
          {DONATE.map((d) => (
            <button
              key={d.label}
              type="button"
              title={d.url}
              aria-label={`Donate with ${d.label}`}
              onClick={() => void openLink(d.url)}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-line2 bg-raised px-3 text-ui text-text hover:bg-raised2"
            >
              <Heart size={13} className="text-accent" /> {d.label}
            </button>
          ))}
        </div>
      </Row>
    </section>
  );
}

/** What Reset puts back: everything Settings changes, and nothing in the library. */
const RESETTABLE: (keyof PrefValues)[] = ["theme", "accent", "sansFont", "sansInstalled", "monoFont", "monoInstalled", "uiScale", "bpmFixed", "autoplay", "playNext", "loopLoops", "loopShots", "miniOnTop", "autoUpdate"];

function resetSettings() {
  useConfirm.getState().ask({
    title: "Reset settings?",
    body: "Appearance, playback and update settings go back to how they were when you first opened Saga. Your library, favorites and collections aren't touched.",
    confirm: "Reset",
    danger: true,
    onConfirm: () => {
      usePrefs.getState().set(Object.fromEntries(RESETTABLE.map((k) => [k, DEFAULT_PREFS[k]])) as Partial<PrefValues>);
      useUi.getState().setOnTop(DEFAULT_PREFS.miniOnTop);
    },
  });
}

/** Folder names left out of every library folder, like "Vocals" inside every pack. */
function ExcludedNames() {
  const [names, setNames] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    api.excludedNames().then(setNames).catch(() => setNames([]));
  }, []);

  const save = async (next: string[]) => {
    try {
      setNames(await api.setExcludedNames(next));
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const add = () => {
    const parts = draft.split(",").map((n) => n.trim()).filter(Boolean);
    if (!parts.length || !names) return;
    setDraft("");
    void save([...names, ...parts]);
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-body">Leave out folders named</span>
        <span className="text-small text-text3">In every library folder, at any depth. Capitals don't matter, and * stands for anything: Vocal* also leaves out Vocal Stems.</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line px-2 py-1.5">
        {names?.map((n) => (
          <span key={n} className="flex h-6 items-center gap-0.5 rounded-md bg-raised2 pr-0.5 pl-2 font-mono text-small text-text">
            {n}
            <button type="button" aria-label={`Stop leaving out folders named ${n}`} onClick={() => void save(names.filter((x) => x !== n))} className="grid h-5 w-5 place-items-center rounded text-text3 hover:text-text">
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          disabled={names == null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && names?.length) {
              void save(names.slice(0, -1));
            }
          }}
          onBlur={add}
          placeholder={names?.length ? "Add another" : "e.g. Vocals, Stems, Old*"}
          aria-label="Folder name to leave out"
          className="h-6 min-w-[160px] flex-1 bg-transparent px-1 text-ui text-text outline-none placeholder:text-text3"
        />
      </div>
    </div>
  );
}

/** Which renders Clear takes: older than this many days, or all of them (0). */
type ClearAge = 30 | 7 | 0;

const CLEAR_AGES: { value: ClearAge; label: string; phrase: string }[] = [
  { value: 30, label: "Older than a month", phrase: "older than a month" },
  { value: 7, label: "Older than a week", phrase: "older than a week" },
  { value: 0, label: "All", phrase: "in the Renders folder" },
];

function clearable(usage: RendersUsage, age: ClearAge): FileCount {
  return age === 30 ? usage.olderThanMonth : age === 7 ? usage.olderThanWeek : usage.all;
}

function files(n: number, what = "render"): string {
  return `${fmtCount(n)} ${n === 1 ? what : `${what}s`}`;
}

/** How much space renders take, and a way to clear the old ones. */
function RendersRow({ path }: { path: string | undefined }) {
  const [usage, setUsage] = useState<RendersUsage | null>(null);
  const [age, setAge] = useState<ClearAge>(30);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!path) return;
    api.rendersUsage().then(setUsage).catch(() => {});
  }, [path]);

  const target = usage ? clearable(usage, age) : null;
  const phrase = CLEAR_AGES.find((a) => a.value === age)!.phrase;
  const clear = async () => {
    setBusy(true);
    try {
      const r = await api.clearRenders(age || null);
      forgetRenders();
      setUsage(r.usage);
      const stayed = r.failed ? `. ${files(r.failed)} ${r.failed === 1 ? "was" : "were"} in use and stayed` : "";
      toast(`Moved ${files(r.cleared.files)} (${fmtBytes(r.cleared.bytes)}) to the Trash${stayed}`, r.failed ? "error" : "info");
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = () => {
    if (!target?.files) return;
    useConfirm.getState().ask({
      title: `Move ${files(target.files)} to the Trash?`,
      body: `That's ${fmtBytes(target.bytes)} of renders ${phrase}. A DAW project that uses one of them will show it as missing until you put it back from the Trash.`,
      confirm: "Move to Trash",
      danger: true,
      onConfirm: () => void clear(),
    });
  };

  const hint = !usage
    ? "Adding up…"
    : usage.all.files
      ? `${fmtBytes(usage.all.bytes)} in ${files(usage.all.files, "file")}`
      : "Empty";
  const ahead = usage?.scratch.files ? `, plus ${fmtBytes(usage.scratch.bytes)} made ahead of time` : "";
  return (
    <Row label="Renders" hint={hint + ahead} block>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented size="sm" label="Renders to clear" value={age} onChange={setAge} options={CLEAR_AGES.map(({ value, label }) => ({ value, label }))} />
        <button
          type="button"
          disabled={busy || !target?.files}
          onClick={ask}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-line2 bg-raised px-3 text-ui text-text hover:bg-raised2 disabled:opacity-50"
        >
          <Trash2 size={14} /> {busy ? "Clearing…" : target?.files ? `Clear ${fmtBytes(target.bytes)}…` : "Nothing to clear"}
        </button>
      </div>
    </Row>
  );
}

function SavedSoundsSection() {
  const [saved, setSaved] = useState<SavedSounds | null>(null);
  useEffect(() => {
    api.savedSounds().then(setSaved).catch(() => {});
  }, []);

  const move = async (to: () => Promise<SavedSounds | null>) => {
    try {
      const moved = await to();
      if (moved) setSaved(moved);
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const button = "flex h-8 items-center gap-1.5 rounded-lg border border-line2 bg-raised px-3 text-ui text-text hover:bg-raised2 disabled:opacity-50";
  return (
    <section>
      <SectionLabel className="pb-1">Saved sounds</SectionLabel>
      <Row label="Location" hint={saved ? `${saved.path}${saved.isDefault ? " (default)" : ""}` : undefined} block>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!saved} onClick={() => void move(api.pickSavedSoundsDir)} className={button}>
            <FolderPen size={14} /> Change…
          </button>
          <button type="button" disabled={!saved} onClick={() => saved && void reveal(saved.path)} className={button}>
            <FolderOpen size={14} /> {revealLabel()}
          </button>
          {saved && !saved.isDefault && (
            <button type="button" onClick={() => void move(api.resetSavedSoundsDir)} className={button}>
              <RotateCcw size={14} /> Use default
            </button>
          )}
        </div>
      </Row>
      <RendersRow path={saved?.path} />
      <div className="flex flex-col gap-2 text-small text-pretty text-text3">
        <p>
          <span className="text-text2">Renders</span> are the sounds Saga makes when you drag a sample you've changed (a new tempo or key, reversed, trimmed) into your DAW. Your project gets what you hear,
          and the original stays untouched. Lab MIDI clips go here too. Saga makes the render ahead of time so the drag is instant, but it only lands here once you drag it; until then it waits in
          Saga's own cache, which clears itself.
        </p>
        <p>
          <span className="text-text2">Variations</span> are the ones you keep on purpose with Save variation in the editor. Saga adds that folder to your library, so they're searchable like any other sample.
        </p>
        <p>Each lives in its own folder here. Changing the location only affects new sounds: files you've already saved stay where they are, so projects that use them keep working.</p>
      </div>
    </section>
  );
}

/** Grouped like the README's tables; keep both in step with src/hooks/useHotkeys.ts. Several keys are alternatives. */
const SHORTCUTS: { group: string; keys: [string[], string][] }[] = [
  {
    group: "Browsing",
    keys: [
      [["↑ ↓"], "Browse samples (⇧ for 10)"],
      [["Space"], "Play or pause"],
      [["Enter"], "Play from the start"],
      [["←"], "Back to the start"],
      [["F"], "Favorite"],
      [["L"], "Toggle looping"],
      [["⌫"], "Remove from the open collection"],
      [[`${modKey} K`, "/"], "Search"],
      [[`${modKey} ⇧ F`], "Open filters"],
      [["Esc"], "Clear the selection or search, close the editor, or stop"],
      [[`${modKey} A`], "Select all results"],
      [[`${modKey} R`], "Rename the selected samples"],
      [[`${modKey} ⇧ R`], revealLabel()],
      [[`${modKey} / ⇧ click`], "Select several samples"],
      [[`${altKey} click`], "On a folder's arrow: close every folder inside too"],
      [[`${modKey} ,`], "Settings"],
      [[`${modKey} + −`], "Interface bigger / smaller"],
      [[`${modKey} 0`], "Interface at 100%"],
    ],
  },
  {
    group: "Processing",
    keys: [
      [["E"], "Open the editor"],
      [["R"], "Reverse"],
      [["[ ]"], "Semitone down / up (through the key's scale with scale lock)"],
      [["S"], "Sync to project tempo"],
      [["K"], "Match project key"],
      [["T"], "Tap tempo"],
    ],
  },
  {
    group: "Views",
    keys: [
      [["M"], "Sound map or list"],
      [["↑ ↓"], "On the map: walk the similar sounds"],
      [["G"], "Find similar sounds"],
      [["H"], "The Lab"],
    ],
  },
  {
    group: "In the Lab",
    keys: [
      [["↑ ↓"], "Scales: next or previous scale"],
      [["← →"], "Scales: change the root"],
      [["← →"], "Progressions: pick a bar"],
      [["↑ ↓"], "Progressions: change its chord"],
      [["⌫"], "Progressions: clear the bar"],
      [["Space"], "Play the scale or progression"],
      [["Esc"], "Stop the Lab's sound"],
    ],
  },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const sources = useLibrary((s) => s.sources);
  const [devices, setDevices] = useState<{ devices: string[]; current: string | null } | null>(null);
  const [fonts, setFonts] = useState<FontList>(null);
  const [excluding, setExcluding] = useState<SourceInfo | null>(null);

  useEffect(() => {
    api.outputDevices().then(setDevices).catch(() => setDevices({ devices: [], current: null }));
    // Read each time Settings opens, so fonts installed meanwhile show up.
    api.installedFonts().then(setFonts).catch(() => setFonts("error"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened from here (folders to exclude, a confirmation) takes Escape itself.
      if (e.key === "Escape" && document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length === 1) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-50 grid place-items-center bg-(--overlay)" onMouseDown={onClose}>
        <div
          role="dialog"
          aria-label="Settings"
          className="animate-pop flex max-h-[82vh] w-[620px] flex-col overflow-hidden rounded-2xl border border-line2 bg-panel shadow-pop"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-3 pl-6">
            <h1 className="text-title font-semibold">Settings</h1>
            <IconButton label="Close settings" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </header>
          <div className="flex flex-col gap-7 overflow-y-auto px-6 py-5">
            <section>
              <SectionLabel className="pb-1">Appearance</SectionLabel>
              <Row label="Theme">
                <Segmented<ThemePref>
                  label="Theme"
                  value={prefs.theme}
                  onChange={(theme) => prefs.set({ theme })}
                  options={[
                    { value: "system", label: "System" },
                    { value: "dark", label: "Graphite dark" },
                    { value: "light", label: "Graphite light" },
                  ]}
                />
              </Row>
              <Row label="Accent">
                <div role="radiogroup" aria-label="Accent color" className="flex gap-2">
                  {ACCENT_ORDER.map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={prefs.accent === a}
                      aria-label={ACCENTS[a].label}
                      title={ACCENTS[a].label}
                      onClick={() => prefs.set({ accent: a })}
                      className={cx("h-7 w-7 rounded-full ring-offset-2 ring-offset-panel transition-shadow", prefs.accent === a ? "ring-2 ring-text" : "hover:ring-2 hover:ring-line2")}
                      style={{ background: ACCENTS[a].hex }}
                    />
                  ))}
                </div>
              </Row>
              <Row label="Interface size" hint={`Or ${modKey}+ and ${modKey}− anywhere.`}>
                <Segmented<number>
                  label="Interface size"
                  size="sm"
                  value={prefs.uiScale}
                  onChange={(uiScale) => prefs.set({ uiScale })}
                  options={SCALES.map((s) => ({ value: s, label: `${Math.round(s * 100)}%` }))}
                />
              </Row>
              <Row label="Interface font" hint="Names, labels and menus." block>
                <FontChoices label="Interface font" value={prefs.sansFont} fonts={SANS_FONTS} order={SANS_ORDER} sample="Aa" onChange={(sansFont) => prefs.set({ sansFont })} />
                <InstalledFontPicker
                  label="Interface font"
                  fonts={fonts}
                  value={prefs.sansInstalled}
                  active={prefs.sansFont === "installed"}
                  fallback={SANS_FONTS.instrument.label}
                  onPick={(family) => prefs.set({ sansFont: "installed", sansInstalled: family })}
                />
              </Row>
              <Row label="Numbers font" hint="Tempos, keys, times and file paths." block>
                <FontChoices label="Numbers font" value={prefs.monoFont} fonts={MONO_FONTS} order={MONO_ORDER} sample="0:02.61" onChange={(monoFont) => prefs.set({ monoFont })} />
                <InstalledFontPicker
                  label="Numbers font"
                  mono
                  fonts={fonts}
                  value={prefs.monoInstalled}
                  active={prefs.monoFont === "installed"}
                  fallback={MONO_FONTS["geist-mono"].label}
                  onPick={(family) => prefs.set({ monoFont: "installed", monoInstalled: family })}
                />
              </Row>
              <Row label="Tempos with two decimals" hint="124.00 and 123.80 everywhere. Off, decimals show only when a tempo has them: 124, 123.8, 123.45.">
                <Switch checked={prefs.bpmFixed} onChange={(v) => prefs.set({ bpmFixed: v })} />
              </Row>
            </section>

            <section>
              <SectionLabel className="pb-1">Playback</SectionLabel>
              <Row label="Play on select" hint="Preview a sample as soon as you select it.">
                <Switch checked={prefs.autoplay} onChange={(v) => prefs.set({ autoplay: v })} />
              </Row>
              <Row label="Play next" hint="When a sample ends, the next one in the list plays. Loops play once while this is on.">
                <Switch checked={prefs.playNext} onChange={setPlayNext} />
              </Row>
              <Row label="Loop loops" hint="Loops repeat until you stop them.">
                <Switch checked={prefs.loopLoops} onChange={(v) => prefs.set({ loopLoops: v })} />
              </Row>
              <Row label="Loop one-shots">
                <Switch checked={prefs.loopShots} onChange={(v) => prefs.set({ loopShots: v })} />
              </Row>
              <Row label="Mini player stays on top" hint="Keeps the mini player above your DAW.">
                <Switch checked={prefs.miniOnTop} onChange={(v) => useUi.getState().setOnTop(v)} />
              </Row>
              <Row label="Output" hint="Where previews play. Your DAW's output isn't affected.">
                <select
                  aria-label="Audio output"
                  value={devices?.current ?? ""}
                  onChange={async (e) => {
                    const name = e.target.value || null;
                    await api.setOutputDevice(name);
                    setDevices((d) => (d ? { ...d, current: name } : d));
                  }}
                  className="h-8 max-w-[260px] rounded-lg border border-line2 bg-raised px-2 text-ui text-text outline-none"
                >
                  <option value="">System default</option>
                  {devices?.devices.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Row>
            </section>

            <section>
              <div className="flex items-center justify-between pb-2">
                <SectionLabel>Library folders</SectionLabel>
                <div className="flex items-center gap-1">
                  {sources.filter((s) => s.online).length > 1 && (
                    <button
                      type="button"
                      onClick={() => sources.filter((s) => s.online).forEach((s) => void useLibrary.getState().rescan(s.id))}
                      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui text-text2 hover:bg-raised hover:text-text"
                    >
                      <RefreshCw size={14} /> Rescan all
                    </button>
                  )}
                  <button type="button" onClick={() => void chooseFolders()} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui text-text2 hover:bg-raised hover:text-text">
                    <FolderPlus size={14} /> Add folder
                  </button>
                </div>
              </div>
              <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
                {sources.length === 0 && <span className="px-4 py-3 text-ui text-text3">No folders yet.</span>}
                {sources.map((s) => (
                  <div key={s.id} className="flex flex-col">
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <HardDrive size={15} className={s.online ? "text-text3" : "text-text3 opacity-50"} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body">{s.name}</span>
                        <span className="truncate font-mono text-micro text-text3">{s.path}</span>
                      </div>
                      <span className="font-mono text-small text-text3 tabular">{s.online ? fmtCount(s.count) : "Not connected"}</span>
                      <IconButton label={`Choose folders to exclude in ${s.name}`} size={28} disabled={!s.online} onClick={() => setExcluding(s)}>
                        <FolderMinus size={14} />
                      </IconButton>
                      <IconButton label={`Rescan ${s.name}`} size={28} onClick={() => void useLibrary.getState().rescan(s.id)}>
                        <RefreshCw size={14} />
                      </IconButton>
                      <IconButton label={`Remove ${s.name} from library`} size={28} onClick={() => void useLibrary.getState().removeSource(s.id)}>
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                    {s.excluded.map((dir) => (
                      <div key={dir} className="flex h-8 items-center gap-3 pr-4 pl-[43px]">
                        <span className="shrink-0 text-small text-text3">Excluded</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-micro text-text2" title={dir}>
                          {dir}
                        </span>
                        <button
                          type="button"
                          onClick={() => void useLibrary.getState().setExcluded(s.id, dir, false)}
                          className="h-6 rounded-md px-2 text-small text-text2 hover:bg-raised hover:text-text"
                        >
                          Include
                        </button>
                      </div>
                    ))}
                    {s.excluded.length > 0 && <div className="h-1.5" />}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-small text-text3">
                Removing a folder only removes it from Saga; the files stay where they are. To leave out folders inside one of these, use its exclude button, or right-click the folder in the sidebar.
              </p>
              <ExcludedNames />
            </section>

            <SavedSoundsSection />

            <UpdatesSection />

            <SupportSection />

            <section>
              <SectionLabel className="pb-2">Keyboard</SectionLabel>
              <div className="flex flex-col gap-4">
                {SHORTCUTS.map(({ group, keys }) => (
                  <div key={group}>
                    <div className="pb-1.5 text-small font-medium text-text3">{group}</div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                      {keys.map(([alternatives, what]) => (
                        <div key={what} className="flex items-center justify-between gap-3 text-ui">
                          <span className="text-text2">{what}</span>
                          <span className="flex shrink-0 gap-1">
                            {alternatives.map((k) => (
                              <Kbd key={k}>{k}</Kbd>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="flex justify-end">
              <button type="button" onClick={resetSettings} className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-ui text-text2 hover:bg-raised hover:text-text">
                <RotateCcw size={14} /> Reset settings
              </button>
            </section>
          </div>
        </div>
      </div>
      {excluding && <ExcludeFoldersDialog key={excluding.id} source={sources.find((s) => s.id === excluding.id) ?? excluding} onClose={() => setExcluding(null)} />}
    </>
  );
}
