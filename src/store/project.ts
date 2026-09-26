import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_EDIT, type Edit, type Project } from "../lib/processing";

interface ProjectStore extends Project {
  set: (patch: Partial<Project>) => void;
}

/** The tempo and key you're working in, remembered between launches. */
export const useProject = create<ProjectStore>()(
  persist(
    (set) => ({
      bpm: 120,
      key: null,
      sync: false,
      matchKey: false,
      click: false,
      mode: "stretch",
      formants: false,
      set: (patch) => set(patch),
    }),
    {
      name: "saga-project",
      partialize: ({ set: _set, ...values }) => values,
    },
  ),
);

interface EditsStore {
  edits: Record<number, Edit>;
  update: (id: number, patch: Partial<Edit>) => void;
  reset: (id: number) => void;
}

/** Per-sample edits for this session. Originals are never changed; save a variation to keep one. */
export const useEdits = create<EditsStore>((set) => ({
  edits: {},
  update: (id, patch) => set((s) => ({ edits: { ...s.edits, [id]: { ...(s.edits[id] ?? DEFAULT_EDIT), ...patch } } })),
  reset: (id) =>
    set((s) => {
      const edits = { ...s.edits };
      delete edits[id];
      return { edits };
    }),
}));

export function editFor(id: number): Edit {
  return useEdits.getState().edits[id] ?? DEFAULT_EDIT;
}

export function useEdit(id: number | undefined): Edit {
  return useEdits((s) => (id == null ? DEFAULT_EDIT : (s.edits[id] ?? DEFAULT_EDIT)));
}
