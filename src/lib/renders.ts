// Processed renders for dragging and exporting. Identical requests share one file.

import { useEffect, useState } from "react";
import { editFor, useEdit, useProject } from "../store/project";
import { api, errorMessage } from "./api";
import { computeProcessing, type Processing } from "./processing";
import type { SampleRow } from "./types";

const renders = new Map<string, Promise<string>>();

function renderKey(row: SampleRow, p: Processing): string {
  return `${row.id}|${JSON.stringify({ ...p.params, beat: null })}`;
}

/** The file to hand to a DAW: the original, or a render of what you're hearing. */
export function fileFor(row: SampleRow, p: Processing = computeProcessing(row, useProject.getState(), editFor(row.id))): Promise<string> {
  if (!p.processed) return Promise.resolve(row.path);
  const key = renderKey(row, p);
  let r = renders.get(key);
  if (!r) {
    r = api.renderSample(row.id, p.params, p.label);
    r.catch(() => renders.delete(key));
    renders.set(key, r);
  }
  return r;
}

export type RenderState =
  | { kind: "original"; path: string }
  | { kind: "rendering" }
  | { kind: "ready"; path: string }
  | { kind: "error"; message: string };

/** Keeps a render of `row` ready while its settings are stable, so dragging it is instant. */
export function useRender(row: SampleRow | null): { state: RenderState; processing: Processing | null } {
  const project = useProject();
  const edit = useEdit(row?.id);
  const processing = row ? computeProcessing(row, project, edit) : null;
  const key = row && processing?.processed ? renderKey(row, processing) : null;
  const [state, setState] = useState<RenderState>({ kind: "rendering" });

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
  }, [key, row?.id, row?.path]);

  return { state, processing };
}
