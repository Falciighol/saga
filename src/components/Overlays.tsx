import { getCurrentWebview } from "@tauri-apps/api/webview";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { addToCollection, useDragState } from "../lib/actions";
import { api } from "../lib/api";
import { pixelRatio } from "../lib/scale";
import { useLibrary } from "../store/library";
import { useSimilar } from "../store/similar";
import { useToasts } from "../store/toasts";
import { cx } from "./ui";

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-[280px] left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "animate-pop pointer-events-auto flex items-center gap-3 rounded-xl border bg-panel py-2 pr-2 pl-4 text-ui shadow-pop",
            t.tone === "error" ? "border-[#7A3A30]" : "border-line2",
          )}
        >
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="grid h-6 w-6 place-items-center rounded-md text-text3 hover:text-text">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function collectionAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-collection-id]");
  return el ? Number(el.getAttribute("data-collection-id")) : null;
}

function similarPanelAt(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y)?.closest("[data-similar-drop]") ?? null;
}

const AUDIO = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|oga|m4a|caf)$/i;

/**
 * Handles files dragged onto the window: folders from Finder become library folders,
 * samples dropped on a collection are added to it, and a sound dropped on the Similar
 * sounds panel finds samples like it.
 */
export function DropTarget() {
  const [over, setOver] = useState(false);
  const internal = useDragState((s) => s.internal);

  useEffect(() => {
    let highlighted: Element | null = null;
    const highlightEl = (el: Element | null) => {
      if (el === highlighted) return;
      highlighted?.removeAttribute("data-drop-target");
      highlighted = el;
      highlighted?.setAttribute("data-drop-target", "true");
    };
    const highlight = (id: number | null) => highlightEl(id == null ? null : document.querySelector(`[data-collection-id="${id}"]`));
    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        setOver(true);
        const scale = pixelRatio();
        const [x, y] = [p.position.x / scale, p.position.y / scale];
        const panel = useDragState.getState().internal ? null : similarPanelAt(x, y);
        if (panel) highlightEl(panel);
        else highlight(collectionAt(x, y));
      } else if (p.type === "leave") {
        setOver(false);
        highlight(null);
      } else if (p.type === "drop") {
        setOver(false);
        highlight(null);
        const scale = pixelRatio();
        const [x, y] = [p.position.x / scale, p.position.y / scale];
        const sound = p.paths.find((path) => AUDIO.test(path));
        if (!useDragState.getState().internal && sound && similarPanelAt(x, y)) {
          useSimilar.getState().fromFile(sound);
          return;
        }
        const target = collectionAt(x, y);
        if (target != null) {
          const ids = await api.idsForPaths(p.paths);
          if (ids.length) await addToCollection(target, ids);
          return;
        }
        if (!useDragState.getState().internal) await useLibrary.getState().addFolders(p.paths);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  if (!over) return null;
  const similar = !internal && document.querySelector("[data-similar-drop]") != null;
  return (
    <div className="pointer-events-none fixed inset-0 z-30 grid place-items-center">
      <div className="absolute inset-2 rounded-2xl border-2 border-dashed border-accent opacity-60" />
      <span className="rounded-xl bg-panel px-4 py-2 text-ui shadow-pop">
        {internal
          ? "Drop on a collection to add it there"
          : similar
            ? "Drop folders to add them, or a sound on Similar sounds to find samples like it"
            : "Drop folders to add them to your library"}
      </span>
    </div>
  );
}
