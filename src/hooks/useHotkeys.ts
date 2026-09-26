import { useEffect, type RefObject } from "react";
import { hasMod, isTextInput } from "../lib/platform";
import { useMenu } from "../components/Menu";
import { useBrowse } from "../store/browse";
import { useEditor } from "../store/editor";
import { shouldLoop, usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { editFor, useEdits, useProject } from "../store/project";
import { useTapTempo } from "../components/ProjectControls";
import { findSimilar } from "../lib/actions";
import { stepScale } from "../lib/scale";
import { useSimilar } from "../store/similar";
import { useSoundMap } from "../store/soundmap";
import { useUi } from "../store/ui";

/** Keyboard-first browsing. Arrow keys keep working while the search box has focus. */
export function useHotkeys(search: RefObject<HTMLInputElement | null>, openSettings: () => void) {
  const tap = useTapTempo((bpm) => useProject.getState().set({ bpm }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Interface size works everywhere, Settings included.
      if (hasMod(e) && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
        e.preventDefault();
        const prefs = usePrefs.getState();
        const uiScale = e.key === "0" ? 1 : stepScale(prefs.uiScale, e.key === "-" || e.key === "_" ? -1 : 1);
        prefs.set({ uiScale });
        return;
      }
      // Menus and dialogs (filters, settings, prompts) handle their own keys, Escape included.
      if (useMenu.getState().menu || document.querySelector('[role="dialog"]')) return;
      if (e.target instanceof HTMLInputElement && e.target.type === "range" && e.key.startsWith("Arrow")) return;
      const browse = useBrowse.getState();
      const player = usePlayer.getState();
      const typing = isTextInput(e.target);
      const inSearch = e.target === search.current;
      const row = browse.selected;
      const editing = useEditor.getState().openId != null;
      const ui = useUi.getState();
      const onMap = ui.view === "map" && !ui.mini && !editing;
      const similar = useSimilar.getState();

      if (hasMod(e) && (e.key === "k" || e.key === "f") && !e.shiftKey) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (hasMod(e) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        // The filters live above the list.
        if (onMap) ui.setView("list");
        window.setTimeout(() => window.dispatchEvent(new Event("saga:open-filters")), 0);
        return;
      }
      if (hasMod(e) && e.key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !editing) {
        if (typing && !inSearch) return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? (e.shiftKey ? 10 : 1) : e.shiftKey ? -10 : -1;
        // On the map, arrows walk the Similar sounds list.
        if (onMap) similar.move(delta);
        else browse.move(delta);
        return;
      }
      if (e.key === "Enter" && (inSearch || !typing) && row) {
        e.preventDefault();
        player.play(row);
        return;
      }
      if (e.key === "Escape") {
        if (similar.recording) {
          similar.cancelRecording();
        } else if (editing && !typing) {
          useEditor.getState().close();
        } else if (inSearch && browse.text) {
          browse.setText("");
        } else if (typing) {
          (e.target as HTMLElement).blur();
        } else if (onMap && useSoundMap.getState().selection.length) {
          useSoundMap.getState().setSelection([]);
        } else if (player.status !== "idle") {
          player.stop();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === " ") {
        e.preventDefault();
        player.toggle(row);
      } else if (e.key === "ArrowLeft" && row) {
        e.preventDefault();
        player.seek(row, 0);
      } else if ((e.key === "f" || e.key === "F") && row) {
        browse.toggleFavorite(row);
      } else if ((e.key === "e" || e.key === "E") && row && !ui.mini) {
        if (editing) useEditor.getState().close();
        else useEditor.getState().open(row.id);
      } else if ((e.key === "m" || e.key === "M") && !ui.mini && !editing) {
        ui.toggleView();
      } else if ((e.key === "g" || e.key === "G") && row && !ui.mini) {
        findSimilar(row);
      } else if ((e.key === "r" || e.key === "R") && row) {
        useEdits.getState().update(row.id, { reverse: !editFor(row.id).reverse });
      } else if (e.key === "[" || e.key === "]") {
        if (row) {
          const cur = editFor(row.id).semitones;
          useEdits.getState().update(row.id, { semitones: Math.max(-24, Math.min(24, cur + (e.key === "]" ? 1 : -1))) });
        }
      } else if (e.key === "s" || e.key === "S") {
        useProject.getState().set({ sync: !useProject.getState().sync });
      } else if (e.key === "k" || e.key === "K") {
        const p = useProject.getState();
        if (p.key) p.set({ matchKey: !p.matchKey });
      } else if (e.key === "t" || e.key === "T") {
        tap();
      } else if ((e.key === "l" || e.key === "L") && row) {
        const next = !shouldLoop(row);
        usePrefs.getState().set(row.kind === "loop" ? { loopLoops: next } : { loopShots: next });
        if (player.id === row.id) player.setLooping(next);
      } else if (e.key === "/") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, openSettings, tap]);
}
