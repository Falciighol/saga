// Processed renders for dragging and exporting. Identical requests share one file. Renders made
// ahead of time wait in Saga's cache; dragging one out moves it into Music › Saga › Renders.

import { useEffect, useState } from "react";
import { editFor, useEdit, useProject } from "../store/project";
import { api, errorMessage } from "./api";
import { computeProcessing, type Processing } from "./processing";
import type { SampleRow } from "./types";

const renders = new Map<string, { path: Promise<string>; kept: boolean }>();

function renderKey(row: SampleRow, p: Processing): string {
  return `${row.id}|${JSON.stringify({ ...p.params, beat: null })}`;
}

/**
 * The original, or a render of what you're hearing. `keep` is for handing the file to a DAW: the
 * render then lives in the saved sounds folder, where projects can rely on it.
 */
export function fileFor(row: SampleRow, p: Processing = computeProcessing(row, useProject.getState(), editFor(row.id)), keep = false): Promise<string> {
  if (!p.processed) return Promise.resolve(row.path);
  const key = renderKey(row, p);
  const known = renders.get(key);
  if (known && (known.kept || !keep)) return known.path;
  // A render still being made ahead of time is finished first, so it's moved rather than made twice.
  const before = known ? known.path.catch(() => null) : Promise.resolve(null);
  const entry = { path: before.then(() => api.renderSample(row.id, p.params, p.label, keep)), kept: keep };
  entry.path.catch(() => renders.get(key) === entry && renders.delete(key));
  renders.set(key, entry);
  return entry.path;
}

/** Forgets every render, after they've been cleared away. */
export function forgetRenders() {
  renders.clear();
}

export type RenderState =
  | { kind: "original"; path: string }
  | { kind: "rendering" }
  | { kind: "ready"; path: string }
  | { kind: "error"; message: string };

/** Keeps a render of `row` ready while its settings are stable, so dragging it is instant. */
export function useRender(row: SampleRow | null): { state: RenderState; processing: Processing | null; retry: () => void } {
  const project = useProject();
  const edit = useEdit(row?.id);
  const processing = row ? computeProcessing(row, project, edit) : null;
  const key = row && processing?.processed ? renderKey(row, processing) : null;
  const [state, setState] = useState<RenderState>({ kind: "rendering" });
  // Bumped to try a failed render again; fileFor has already forgotten the failure.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!row || !processing) return;
    if (!processing.processed) {
      setState({ kind: "original", path: row.path });
      return;
    }
    let live = true;
    setState({ kind: "rendering" });
    const t = window.setTimeout(() => {
      fileFor(row, processing)
        .then((path) => live && setState({ kind: "ready", path }))
        .catch((e) => live && setState({ kind: "error", message: errorMessage(e) }));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // `key` captures everything that changes the render.
  }, [key, row?.id, row?.path, attempt]);

  return { state, processing, retry: () => setAttempt((n) => n + 1) };
}
