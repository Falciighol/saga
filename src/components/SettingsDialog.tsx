import { getVersion } from "@tauri-apps/api/app";
import { FolderPlus, HardDrive, Heart, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { openLink } from "../lib/actions";
import { api } from "../lib/api";
import { MONO_FONTS, MONO_ORDER, SANS_FONTS, SANS_ORDER } from "../lib/fonts";
import { fmtCount } from "../lib/format";
import { modKey } from "../lib/platform";
import { SCALES } from "../lib/scale";
import { ACCENT_ORDER, ACCENTS, type ThemePref } from "../lib/theme";
import { useLibrary } from "../store/library";
import { usePrefs } from "../store/prefs";
import { useUpdates, type UpdateStatus } from "../store/updates";
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

const SHORTCUTS: [string, string][] = [
  ["↑ ↓", "Browse samples"],
  ["Space", "Play or pause"],
  ["Enter", "Play from the start"],
  ["←", "Back to the start"],
  ["F", "Favorite"],
  ["L", "Toggle looping"],
  [`${modKey} K`, "Search"],
  [`${modKey} ⇧ F`, "Open filters"],
  ["Esc", "Clear search or stop"],
  [`${modKey} ,`, "Settings"],
  [`${modKey} + −`, "Interface bigger / smaller"],
  [`${modKey} 0`, "Interface at 100%"],
  ["E", "Open the editor"],
  ["R", "Reverse"],
  ["[ ]", "Semitone down / up (through the key's scale with scale lock)"],
  ["S", "Sync to project tempo"],
  ["K", "Match project key"],
  ["T", "Tap tempo"],
  ["M", "Sound map or list"],
  ["G", "Find similar sounds"],
  ["H", "The Lab"],
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const sources = useLibrary((s) => s.sources);
  const [devices, setDevices] = useState<{ devices: string[]; current: string | null } | null>(null);
  const [fonts, setFonts] = useState<FontList>(null);

  useEffect(() => {
    api.outputDevices().then(setDevices).catch(() => setDevices({ devices: [], current: null }));
    // Read each time Settings opens, so fonts installed meanwhile show up.
    api.installedFonts().then(setFonts).catch(() => setFonts("error"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
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
          </section>

          <section>
            <SectionLabel className="pb-1">Playback</SectionLabel>
            <Row label="Play on select" hint="Preview a sample as soon as you select it.">
              <Switch checked={prefs.autoplay} onChange={(v) => prefs.set({ autoplay: v })} />
            </Row>
            <Row label="Loop loops" hint="Loops repeat until you stop them.">
              <Switch checked={prefs.loopLoops} onChange={(v) => prefs.set({ loopLoops: v })} />
            </Row>
            <Row label="Loop one-shots">
              <Switch checked={prefs.loopShots} onChange={(v) => prefs.set({ loopShots: v })} />
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
              <button type="button" onClick={() => void chooseFolders()} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui text-text2 hover:bg-raised hover:text-text">
                <FolderPlus size={14} /> Add folder
              </button>
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
              Removing a folder only removes it from Saga. Your files are never moved or changed. To leave out a folder inside one of these, right-click it in the sidebar.
            </p>
          </section>

          <UpdatesSection />

          <SupportSection />

          <section>
            <SectionLabel className="pb-2">Keyboard</SectionLabel>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2">
              {SHORTCUTS.map(([k, what]) => (
                <div key={what} className="flex items-center justify-between gap-3 text-ui">
                  <span className="text-text2">{what}</span>
                  <Kbd>{k}</Kbd>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
