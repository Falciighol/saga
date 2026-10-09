import { FolderOpen, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { reveal } from "../../lib/actions";
import { isMac, revealLabel } from "../../lib/platform";
import type { TakeFormat, TakesRetention } from "../../lib/types";
import { useRecord } from "../../store/record";
import { cx, IconButton, SectionLabel, Segmented } from "../ui";

/** "CommandOrControl+Shift+R" as the keyboard shows it: ⌘⇧R on a Mac, Ctrl+Shift+R on Windows. */
export function shortcutLabel(accelerator: string): string {
  const parts = accelerator.split("+");
  const mac: Record<string, string> = { CommandOrControl: "⌘", Command: "⌘", Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
  const win: Record<string, string> = { CommandOrControl: "Ctrl", Control: "Ctrl", Super: "Win", Alt: "Alt", Shift: "Shift" };
  return isMac ? parts.map((p) => mac[p] ?? p).join("") : parts.map((p) => win[p] ?? p).join("+");
}

/** The key as Tauri spells it, or null for keys a shortcut can't use. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code === "Space") return "Space";
  return null;
}

/** Turns a key press into a shortcut. Plain letters would fire while typing anywhere, so they need a modifier;
 *  function keys may go alone. */
function accelerator(e: ReactKeyboardEvent): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("CommandOrControl");
  if (isMac && e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const functionKey = /^F\d/.test(key);
  if (!functionKey && !mods.some((m) => m !== "Shift")) return null;
  return [...mods, key].join("+");
}

function ShortcutPicker() {
  const shortcut = useRecord((s) => s.settings?.shortcut ?? null);
  const [listening, setListening] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const onKeyDown = async (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setListening(false);
      setHint(null);
      return;
    }
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const accel = accelerator(e);
    if (!accel) {
      setHint(isMac ? "Add ⌘, ⌥ or ⌃, or use a function key" : "Add Ctrl or Alt, or use a function key");
      return;
    }
    setListening(false);
    setHint(null);
    await useRecord.getState().setShortcut(accel);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={listening ? "Press the keys for the shortcut, or Escape to cancel" : shortcut ? `Shortcut ${shortcutLabel(shortcut)}. Change` : "Set a shortcut"}
          onClick={() => {
            setListening(true);
            setHint(null);
          }}
          onBlur={() => setListening(false)}
          onKeyDown={(e) => void onKeyDown(e)}
          className={cx(
            "flex h-8 min-w-[120px] items-center justify-center rounded-lg border px-3 text-ui",
            listening ? "border-accent-wave bg-accent-soft text-accent-ink" : "border-line2 bg-raised text-text hover:bg-raised2",
          )}
        >
          {listening ? "Press keys…" : shortcut ? <span className="font-mono tabular">{shortcutLabel(shortcut)}</span> : "Set shortcut…"}
        </button>
        {shortcut && !listening && (
          <IconButton label="Remove the shortcut" size={28} onClick={() => void useRecord.getState().setShortcut(null)}>
            <X size={14} />
          </IconButton>
        )}
      </div>
      {hint && <span className="text-small text-text3">{hint}</span>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body">{label}</span>
        {hint && <span className="text-small text-pretty text-text3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const FORMATS: { value: TakeFormat; label: string }[] = [
  { value: "24", label: "24-bit" },
  { value: "float", label: "32-bit float" },
];

const RETENTION: { value: TakesRetention; label: string }[] = [
  { value: "keep", label: "Keep until I delete them" },
  { value: "week", label: "Move to the Trash after 7 days" },
  { value: "quit", label: "Move to the Trash when Saga quits" },
];

/** Settings › Recording: the shortcut from anywhere, the file format, unsaved takes and where saved ones go. */
export function RecordingSection() {
  const settings = useRecord((s) => s.settings);
  useEffect(() => {
    void useRecord.getState().loadSettings();
  }, []);
  return (
    <section>
      <SectionLabel className="pb-1">Recording</SectionLabel>
      <Row label="Shortcut from anywhere" hint="Arms, records and stops even while your DAW has focus. Pick keys your DAW doesn't use.">
        <ShortcutPicker />
      </Row>
      <Row label="File format" hint="WAV at the source's own sample rate, never resampled. 32-bit float keeps sound that goes past full scale in other apps.">
        <Segmented
          label="File format"
          value={settings?.format ?? "24"}
          options={FORMATS}
          onChange={(format) => void useRecord.getState().setSettings({ format })}
        />
      </Row>
      <Row label="Unsaved takes" hint="Takes you save, or drag into your DAW, stay in Recordings whatever you pick. Even cleared takes go to the Trash.">
        <select
          aria-label="Unsaved takes"
          value={settings?.retention ?? "keep"}
          onChange={(e) => void useRecord.getState().setSettings({ retention: e.target.value as TakesRetention })}
          className="h-8 max-w-[240px] rounded-lg border border-line2 bg-raised px-2 text-ui text-text outline-none"
        >
          {RETENTION.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Saved takes" hint={settings ? <span className="font-mono text-micro">{settings.recordings}</span> : undefined}>
        <button
          type="button"
          disabled={!settings}
          onClick={() => settings && void reveal(settings.recordings)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line2 bg-raised px-3 text-ui text-text hover:bg-raised2 disabled:opacity-50"
        >
          <FolderOpen size={14} /> {revealLabel()}
        </button>
      </Row>
      <p className="m-0 text-small text-pretty text-text3">
        Saved takes go to Recordings in your saved sounds folder, which Saga adds to your library, so they're searchable like any other sample. Change that folder under
        Saved sounds.
      </p>
    </section>
  );
}
