import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import type { FolderCandidate, Subfolder } from "../lib/types";
import { useLibrary } from "../store/library";
import { cx } from "./ui";

interface AddFoldersState {
  candidates: FolderCandidate[] | null;
  open: (candidates: FolderCandidate[]) => void;
  close: () => void;
}

const useAddFolders = create<AddFoldersState>((set) => ({
  candidates: null,
  open: (candidates) => set({ candidates }),
  close: () => set({ candidates: null }),
}));

/**
 * Adds folders to the library. When they have folders inside, a checklist comes first,
 * so some can be left out before anything is indexed.
 */
export async function reviewFolders(paths: string[]) {
  if (paths.length === 0) return;
  let candidates: FolderCandidate[] = [];
  try {
    candidates = await api.folderCandidates(paths);
  } catch {
    // Without the list there's nothing to choose from; add them as they are.
  }
  if (candidates.some((c) => c.subfolders.length > 0)) useAddFolders.getState().open(candidates);
  else await useLibrary.getState().addFolders(paths);
}

/** A folder in the checklist: the candidate's index, then its path inside that candidate ("" for the candidate itself). */
const keyOf = (index: number, rel: string) => `${index}|${rel}`;

function AddFoldersDialog({ candidates, onClose }: { candidates: FolderCandidate[]; onClose: () => void }) {
  /** Unticked folders. One covers everything inside it. */
  const [off, setOff] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(candidates.map((_, i) => keyOf(i, ""))));
  const [children, setChildren] = useState<Record<string, Subfolder[]>>(() => Object.fromEntries(candidates.map((c, i) => [keyOf(i, ""), c.subfolders])));
  const add = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    add.current?.focus();
  }, []);

  const offByParent = (index: number, rel: string) => {
    if (rel === "") return false;
    if (off.has(keyOf(index, ""))) return true;
    const segs = rel.split("/");
    return segs.slice(0, -1).some((_, i) => off.has(keyOf(index, segs.slice(0, i + 1).join("/"))));
  };
  const inside = (index: number, rel: string) => keyOf(index, rel === "" ? "" : `${rel}/`);

  const toggle = (index: number, rel: string) => {
    const key = keyOf(index, rel);
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        for (const k of next) if (k.startsWith(inside(index, rel))) next.delete(k);
        next.add(key);
      }
      return next;
    });
  };

  const expand = (index: number, rel: string) => {
    const key = keyOf(index, rel);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!children[key]) {
      api
        .listSubfolders(`${candidates[index].path}/${rel}`)
        .then((list) => setChildren((c) => ({ ...c, [key]: list })))
        .catch(() => setChildren((c) => ({ ...c, [key]: [] })));
    }
  };

  const row = (index: number, rel: string, name: string, hasChildren: boolean, depth: number) => {
    const key = keyOf(index, rel);
    const disabled = offByParent(index, rel);
    const checked = !disabled && !off.has(key);
    const partial = checked && [...off].some((k) => k !== key && k.startsWith(inside(index, rel)));
    const open = expanded.has(key);
    const root = rel === "";
    return (
      <div key={key}>
        <div className="flex h-8 items-center gap-2 rounded-md pr-2 hover:bg-raised" style={{ paddingLeft: 6 + depth * 18 }}>
          {hasChildren ? (
            <button type="button" aria-label={open ? `Collapse ${name}` : `Expand ${name}`} onClick={() => expand(index, rel)} className="grid h-5 w-5 shrink-0 place-items-center rounded text-text3 hover:text-text">
              {open ? <ChevronDown size={12} strokeWidth={2.25} /> : <ChevronRight size={12} strokeWidth={2.25} />}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <label className={cx("flex min-w-0 flex-1 items-center gap-2.5", disabled && "opacity-45")}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              ref={(el) => {
                if (el) el.indeterminate = partial;
              }}
              onChange={() => toggle(index, rel)}
              className="h-[15px] w-[15px] shrink-0"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className={cx("shrink-0 truncate text-ui", root ? "max-w-[45%] font-semibold" : "max-w-full")}>{name}</span>
            {root && <span className="min-w-0 flex-1 truncate font-mono text-micro text-text3">{candidates[index].path}</span>}
          </label>
        </div>
        {open && children[key]?.map((c) => row(index, rel === "" ? c.name : `${rel}/${c.name}`, c.name, c.hasChildren, depth + 1))}
      </div>
    );
  };

  const chosen = candidates.map((c, i) => ({ path: c.path, index: i })).filter((c) => !off.has(keyOf(c.index, "")));
  const submit = () => {
    const exclude: Record<string, string[]> = {};
    for (const c of chosen) {
      const prefix = keyOf(c.index, "");
      exclude[c.path] = [...off].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    }
    void useLibrary.getState().addFolders(chosen.map((c) => c.path), exclude);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-(--overlay)" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-label="Add to your library"
        className="animate-pop flex max-h-[80vh] w-[520px] flex-col rounded-2xl border border-line2 bg-panel p-5 shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen.length) submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-title font-semibold">Add to your library</span>
          <span className="text-ui text-pretty text-text2">Untick any folders you'd rather leave out. You can change this later from the sidebar or Settings.</span>
        </div>
        <div className="mt-4 -mx-1.5 flex min-h-0 flex-col overflow-y-auto">{candidates.map((c, i) => row(i, "", c.name, c.subfolders.length > 0, 0))}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-ui text-text2 hover:bg-raised">
            Cancel
          </button>
          <button ref={add} type="submit" disabled={chosen.length === 0} className="h-8 rounded-lg bg-accent px-3.5 text-ui font-semibold text-on-accent disabled:opacity-40">
            Add {chosen.length === 1 ? "folder" : `${chosen.length} folders`}
          </button>
        </div>
      </form>
    </div>
  );
}

export function AddFoldersHost() {
  const candidates = useAddFolders((s) => s.candidates);
  const close = useAddFolders((s) => s.close);
  // Keyed, so each batch of folders starts from a fresh checklist.
  return candidates ? <AddFoldersDialog key={candidates.map((c) => c.path).join("\n")} candidates={candidates} onClose={close} /> : null;
}
