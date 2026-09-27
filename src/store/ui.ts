import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { useEditor } from "./editor";
import { usePrefs } from "./prefs";
import { toast } from "./toasts";

export type MainView = "list" | "map" | "lab";

interface UiState {
  /** The browser shows samples as a list or as the sound map, or the Lab is open. */
  view: MainView;
  /** The window is the compact mini player. */
  mini: boolean;
  setView: (view: MainView) => void;
  toggleView: () => void;
  toggleLab: () => void;
  setMini: (mini: boolean) => void;
  setOnTop: (onTop: boolean) => void;
}

export const useUi = create<UiState>((set, get) => ({
  view: "list",
  mini: false,
  setView: (view) => {
    useEditor.getState().close();
    set({ view });
  },
  toggleView: () => get().setView(get().view === "map" ? "list" : "map"),
  toggleLab: () => get().setView(get().view === "lab" ? "list" : "lab"),
  setMini: (mini) => {
    if (mini) useEditor.getState().close();
    set({ mini });
    api.setWindowMode(mini, usePrefs.getState().miniOnTop).catch((e) => toast(errorMessage(e)));
  },
  setOnTop: (onTop) => {
    usePrefs.getState().set({ miniOnTop: onTop });
    if (get().mini) api.setWindowMode(true, onTop).catch((e) => toast(errorMessage(e)));
  },
}));
