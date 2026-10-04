import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import type { FolderCandidate } from "../lib/types";
import { useLibrary } from "../store/library";
import { FolderChecklist, keyOf, offIn } from "./FolderChecklist";

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

function AddFoldersDialog({ candidates, onClose }: { candidates: FolderCandidate[]; onClose: () => void }) {
  /** Unticked folders. One covers everything inside it. */
  const [off, setOff] = useState<Set<string>>(new Set());
  const add = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    add.current?.focus();
  }, []);

  const chosen = candidates.map((c, i) => ({ path: c.path, index: i })).filter((c) => !off.has(keyOf(c.index, "")));
  const submit = () => {
    const exclude: Record<string, string[]> = {};
    for (const c of chosen) exclude[c.path] = offIn(off, c.index);
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
        <div className="mt-4 -mx-1.5 flex min-h-0 flex-col overflow-y-auto">
          <FolderChecklist roots={candidates} off={off} setOff={setOff} />
        </div>
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
