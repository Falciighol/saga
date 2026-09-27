import { create } from "zustand";
import { persist } from "zustand/middleware";
import { computeProcessing, DEFAULT_EDIT, type Edit, type Project, type ProjectKey } from "../lib/processing";
import { plainScale, scaleById, scaleStep, type Scale } from "../lib/theory";
import type { SampleRow } from "../lib/types";

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
      scaleLock: false,
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

/** The project key's full scale: the Lab scale if it has one, else plain major or minor. */
export function projectScale(key: ProjectKey): Scale {
  return scaleById(key.scale) ?? plainScale(key.mode);
}

/** Manual transposition stays within two octaves either way. */
const MAX_SEMITONES = 24;

/**
 * Semitones a pitch step moves `row` by: one, or with scale lock the distance to the next place
 * in the project key's scale (the next note for a one-shot's root, the next key that fits for a
 * loop). Scale lock needs a project key and a sample with a key; otherwise it's a semitone.
 */
export function pitchStep(row: SampleRow, dir: 1 | -1, project: Project = useProject.getState(), edit: Edit = editFor(row.id)): number {
  if (!project.scaleLock || !project.key || row.keyPc == null || row.keyMode == null) return dir;
  const heard = Math.round(computeProcessing(row, project, edit).semitones);
  const scale = projectScale(project.key);
  return scaleStep(row.keyPc + heard, row.keyMode as 0 | 1 | 2, project.key.pc, scale.steps, dir) ?? dir;
}

/** `[`, `]` and the pitch buttons: transposes by a semitone, or through the scale with scale lock. */
export function stepPitch(row: SampleRow, dir: 1 | -1) {
  const edit = editFor(row.id);
  const next = edit.semitones + pitchStep(row, dir, useProject.getState(), edit);
  if (Math.abs(next) > MAX_SEMITONES) return;
  useEdits.getState().update(row.id, { semitones: next });
}
