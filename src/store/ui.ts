import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { useEditor } from "./editor";
import { usePrefs } from "./prefs";
import { toast } from "./toasts";

export type MainView = "list" | "map";

interface UiState {
  /** The browser shows samples as a list or as the sound map. */
  view: MainView;
  /** The window is the compact mini player. */
  mini: boolean;
  setView: (view: MainView) => void;
  toggleView: () => void;
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
