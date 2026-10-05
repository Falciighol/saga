import { useEffect, type RefObject } from "react";
import { hasMod, isTextInput } from "../lib/platform";
import { useMenu } from "../components/Menu";
import { targetIds, useBrowse } from "../store/browse";
import { useEditor } from "../store/editor";
import { usePlayer } from "../store/player";
import { usePrefs } from "../store/prefs";
import { editFor, stepPitch, useEdits, useProject } from "../store/project";
import { useTapTempo } from "../components/ProjectControls";
import { findSimilar, removeFromCollection, toggleLoop } from "../lib/actions";
import { stepScale } from "../lib/scale";
import { auditionChord, chordNotes, labScale, playChord, playScale, stopNotes, stopProgression, toggleProgression, useLab } from "../store/lab";
import { scaleChords } from "../lib/theory";
import { sameChord, sketchScale } from "../lib/progressions";
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
      const inLab = ui.view === "lab" && !ui.mini && !editing;
      const similar = useSimilar.getState();

      if (hasMod(e) && (e.key === "k" || e.key === "f") && !e.shiftKey) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (hasMod(e) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        // The filters live above the list, so leave the mini player, map, Lab or editor for it.
        if (ui.mini) ui.setMini(false);
        if (ui.view !== "list" || editing) ui.setView("list");
        window.setTimeout(() => window.dispatchEvent(new Event("saga:open-filters")), 0);
        return;
      }
      // Select every sample the search and filters match.
      if (hasMod(e) && !e.shiftKey && e.key.toLowerCase() === "a" && !typing && ui.view === "list" && !ui.mini && !editing) {
        e.preventDefault();
        void browse.pickAll();
        return;
      }
      if (hasMod(e) && e.key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }
      // In the Lab: in Scales, arrows walk scales and roots and Space plays the scale; in
      // Progressions, arrows pick a bar and step its chord, and Space plays the progression.
      // The key finder and tuning work on the selected sample, so there the list's keys apply.
      if (inLab && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const lab = useLab.getState();
        if (lab.tool === "progressions") {
          if (progressionKey(e)) {
            e.preventDefault();
            return;
          }
        } else if (lab.tool === "scales") {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            lab.stepScale(e.key === "ArrowDown" ? 1 : -1);
            playScale(lab.pc, labScale());
            return;
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            lab.stepRoot(e.key === "ArrowRight" ? 1 : -1);
            const pc = useLab.getState().pc;
            const tonic = scaleChords(pc, labScale(), false)[0];
            if (tonic) playChord(chordNotes(pc, tonic));
            return;
          }
          if (e.key === " ") {
            e.preventDefault();
            playScale(lab.pc, labScale());
            return;
          }
        }
        if (e.key === "Escape") {
          stopNotes();
          stopProgression();
          if (player.status !== "idle") player.stop();
          return;
        }
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
        } else if (browse.picked.size > 1 && !typing && !onMap) {
          browse.clearPicked();
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

      // In a collection's list, ⌫ (Delete on a Mac keyboard) takes the selected or picked samples out of it.
      if ((e.key === "Backspace" || e.key === "Delete") && browse.view.type === "collection" && (ui.view === "list" || ui.mini) && !editing) {
        e.preventDefault();
        void removeFromCollection(browse.view.id, targetIds(browse));
        return;
      }
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
      } else if ((e.key === "h" || e.key === "H") && !ui.mini) {
        ui.toggleLab();
      } else if ((e.key === "g" || e.key === "G") && row && !ui.mini) {
        findSimilar(row);
      } else if ((e.key === "r" || e.key === "R") && row) {
        useEdits.getState().update(row.id, { reverse: !editFor(row.id).reverse });
      } else if (e.key === "[" || e.key === "]") {
        if (row) stepPitch(row, e.key === "]" ? 1 : -1);
      } else if (e.key === "s" || e.key === "S") {
        useProject.getState().set({ sync: !useProject.getState().sync });
      } else if (e.key === "k" || e.key === "K") {
        const p = useProject.getState();
        if (p.key) p.set({ matchKey: !p.matchKey });
      } else if (e.key === "t" || e.key === "T") {
        tap();
      } else if ((e.key === "l" || e.key === "L") && row) {
        toggleLoop(row);
      } else if (e.key === "/") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [search, openSettings, tap]);
}

/** Progressions keys: Space plays, ← → pick a bar, ↑ ↓ step its chord through the scale, ⌫ clears it. */
function progressionKey(e: KeyboardEvent): boolean {
  const lab = useLab.getState();
  const { sketch, bar } = lab;
  if (e.key === " ") {
    toggleProgression();
    return true;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const next = (bar + (e.key === "ArrowRight" ? 1 : -1) + sketch.length) % sketch.length;
    lab.selectBar(next);
    const ch = sketch.bars[next];
    if (ch) auditionChord(sketch.pc, ch);
    return true;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const palette = scaleChords(sketch.pc, sketchScale(sketch), lab.sevenths);
    if (!palette.length) return true;
    const i = palette.findIndex((c) => sameChord(c, sketch.bars[bar]));
    const step = e.key === "ArrowUp" ? 1 : -1;
    const c = palette[i < 0 ? 0 : (i + step + palette.length) % palette.length];
    lab.setChord(bar, { iv: c.iv, quality: c.quality });
    auditionChord(sketch.pc, c);
    return true;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    lab.setChord(bar, null);
    return true;
  }
  return false;
}
