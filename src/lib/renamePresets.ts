import type { MenuItem } from "../components/Menu";
import { usePrompt } from "../components/Prompt";
import { usePrefs } from "../store/prefs";
import { toast } from "../store/toasts";
import { DEFAULT_PATTERN, type RenamePattern } from "./rename";

/** Built-in starting points. They set the template only, keeping the styles chosen. */
export const PRESETS: { label: string; template: string }[] = [
  { label: "Name, then tempo and key", template: "{name}_{bpm}_{key}" },
  { label: "Tempo and key, then name", template: "{bpm}_{key}_{name}" },
  { label: "Name (key, tempo BPM)", template: "{name} ({key}, {bpm} BPM)" },
  { label: "Name with date created", template: "{name}_{date}" },
  { label: "Key, tempo and date", template: "{name}_{key}_{bpm}_{date}" },
  { label: "Folder name and number", template: "{folder} {n}" },
  { label: "Collection name and number", template: "{collection} {n}" },
];

/** A rename pattern saved under a name of the user's own, listed with the presets. */
export interface SavedPreset {
  name: string;
  pattern: RenamePattern;
}

/** Whether two patterns would give the same names. */
export function samePattern(a: RenamePattern, b: RenamePattern): boolean {
  const x = { ...DEFAULT_PATTERN, ...a };
  const y = { ...DEFAULT_PATTERN, ...b };
  return (Object.keys(DEFAULT_PATTERN) as (keyof RenamePattern)[]).every((k) => x[k] === y[k]);
}

/** Saves a pattern under a name, replacing a preset of the same name. */
export function savePreset(name: string, pattern: RenamePattern) {
  const presets = usePrefs.getState().renamePresets;
  const same = (x: { name: string }) => x.name.toLowerCase() === name.toLowerCase();
  const next = presets.some(same) ? presets.map((x) => (same(x) ? { name, pattern } : x)) : [...presets, { name, pattern }];
  usePrefs.getState().set({ renamePresets: next });
  toast(`Saved the preset “${name}”`, "info");
}

export function deletePreset(name: string) {
  const before = usePrefs.getState().renamePresets;
  usePrefs.getState().set({ renamePresets: before.filter((x) => x.name !== name) });
  toast(`Deleted the preset “${name}”`, "info", { label: "Undo", run: () => usePrefs.getState().set({ renamePresets: before }) });
}

/** The Presets menu: built-in templates, the user's own patterns, and saving or deleting those.
 *  `apply` receives the pattern to switch to. */
export function presetMenu(p: RenamePattern, apply: (next: RenamePattern) => void): MenuItem[] {
  const presets = usePrefs.getState().renamePresets;
  const mine = presets.find((x) => samePattern(x.pattern, p));
  const items: MenuItem[] = PRESETS.map((x) => ({
    label: x.label,
    hint: x.template,
    checked: !mine && x.template === p.template,
    onSelect: () => apply({ ...p, template: x.template }),
  }));
  if (presets.length) {
    items.push(
      "separator",
      ...presets.map((x) => ({ label: x.name, hint: x.pattern.template, checked: x === mine, onSelect: () => apply({ ...DEFAULT_PATTERN, ...x.pattern }) })),
    );
  }
  items.push("separator", {
    label: "Save as preset…",
    disabled: !p.template.trim(),
    onSelect: () =>
      usePrompt.getState().ask({
        title: "Save as preset",
        placeholder: "Preset name",
        initial: mine?.name ?? "",
        confirm: "Save",
        onSubmit: (name) => savePreset(name, p),
      }),
  });
  if (presets.length) {
    items.push({ label: "Delete preset", submenu: presets.map((x) => ({ label: x.name, hint: x.pattern.template, onSelect: () => deletePreset(x.name) })) });
  }
  return items;
}
