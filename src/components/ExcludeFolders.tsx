import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { SourceInfo, Subfolder } from "../lib/types";
import { useLibrary } from "../store/library";
import { FolderChecklist, keyOf, offIn } from "./FolderChecklist";
import { afterExcluded } from "./Sidebar";

/** Picks which folders inside a library folder Saga leaves out. Unticking takes their samples out of the library. */
export function ExcludeFoldersDialog({ source, onClose }: { source: SourceInfo; onClose: () => void }) {
  const initial = useMemo(() => new Set(source.excluded.map((d) => keyOf(0, d))), [source.excluded]);
  const [off, setOff] = useState<Set<string>>(initial);
  const [subfolders, setSubfolders] = useState<Subfolder[] | null>(null);
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    api
      .listSubfolders(source.path)
      .then((list) => live && setSubfolders(list))
      .catch(() => live && setSubfolders([]));
    return () => {
      live = false;
    };
  }, [source.path]);

  // Focus lands in the dialog, so Escape closes it. Save starts disabled.
  useEffect(() => {
    form.current?.focus();
  }, []);

  const now = offIn(off, 0);
  const before = offIn(initial, 0);
  const added = now.filter((d) => !before.includes(d));
  // Ticked again, unless the folder around it was just unticked: that already covers it.
  const removed = before.filter((d) => !now.includes(d) && !added.some((a) => d.startsWith(`${a}/`)));
  const changed = added.length + removed.length > 0;

  const submit = async () => {
    if (!changed || saving) return;
    setSaving(true);
    const { setExcluded } = useLibrary.getState();
    for (const dir of added) if (!(await setExcluded(source.id, dir, true))) break;
    for (const dir of removed) if (!(await setExcluded(source.id, dir, false))) break;
    if (added.length) afterExcluded(source.id, added);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-(--overlay)" onMouseDown={onClose}>
      <form
        ref={form}
        tabIndex={-1}
        role="dialog"
        aria-label={`Exclude folders in ${source.name}`}
        className="animate-pop flex max-h-[80vh] w-[520px] flex-col rounded-2xl outline-none border border-line2 bg-panel p-5 shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-title font-semibold">Folders in “{source.name}”</span>
          <span className="text-ui text-pretty text-text2">Untick any folders you'd rather leave out. Saga skips them, and everything inside them, until you tick them again.</span>
        </div>
        <div className="mt-4 -mx-1.5 flex min-h-[64px] flex-col overflow-y-auto">
          {subfolders == null ? (
            <span className="px-1.5 text-ui text-text3">Reading folders…</span>
          ) : subfolders.length === 0 && source.excluded.length === 0 ? (
            <span className="px-1.5 text-ui text-text3">There are no folders inside this one.</span>
          ) : (
            <FolderChecklist roots={[{ name: source.name, path: source.path, subfolders }]} off={off} setOff={setOff} rootsCheckable={false} />
          )}
        </div>
        {added.length > 0 && (
          <p className="mt-3 text-small text-pretty text-text3">
            Samples in the folders you've unticked leave your library, along with their favorites, tags and places in collections. The files stay where they are.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-ui text-text2 hover:bg-raised">
            Cancel
          </button>
          <button type="submit" disabled={!changed || saving} className="h-8 rounded-lg bg-accent px-3.5 text-ui font-semibold text-on-accent disabled:opacity-40">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
