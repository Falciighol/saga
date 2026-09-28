import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { usePrefs } from "./prefs";

export type UpdateStatus = "idle" | "checking" | "current" | "downloading" | "ready" | "installing" | "error";

interface UpdateState {
  status: UpdateStatus;
  /** The version waiting to be installed. */
  version: string | null;
  /** Download progress 0–1, when the server sends a length. */
  progress: number | null;
  error: string | null;
  /** "Later" on the restart notice; Settings still shows the update. */
  dismissed: boolean;
  /** Looks for a release and downloads it in the background. Quiet checks don't report failures. */
  check: (quiet?: boolean) => Promise<void>;
  /** Installs the downloaded update and starts the new version. */
  restart: () => Promise<void>;
  dismiss: () => void;
}

/** Held outside the store: it's a handle to the download on the Rust side, not UI state. */
let pending: Update | null = null;

export const useUpdates = create<UpdateState>((set, get) => ({
  status: "idle",
  version: null,
  progress: null,
  error: null,
  dismissed: false,

  check: async (quiet = false) => {
    const { status } = get();
    if (status === "checking" || status === "downloading" || status === "ready" || status === "installing") return;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (!update) {
        set({ status: "current" });
        return;
      }
      set({ status: "downloading", version: update.version, progress: null, dismissed: false });
      let total = 0;
      let received = 0;
      await update.download((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress" && total > 0) {
          received += e.data.chunkLength;
          set({ progress: Math.min(1, received / total) });
        }
      });
      pending = update;
      set({ status: "ready", progress: 1 });
    } catch (e) {
      console.warn("saga: update check failed", e);
      set({ status: quiet ? "idle" : "error", error: String(e) });
    }
  },

  restart: async () => {
    if (!pending) return;
    set({ status: "installing", error: null });
    try {
      // On Windows this hands over to the installer, which quits Saga and reopens it.
      await pending.install();
      await relaunch();
    } catch (e) {
      console.warn("saga: installing the update failed", e);
      set({ status: "error", error: String(e) });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));

const HOUR = 60 * 60 * 1000;

/**
 * Checks for updates shortly after launch and then twice a day, since Saga tends to stay open
 * next to a DAW for days. Only release builds check on their own; a dev build would find the
 * published release and try to install it over itself.
 */
export function startUpdateChecks(): () => void {
  if (import.meta.env.DEV) return () => {};
  const run = () => {
    if (usePrefs.getState().autoUpdate) void useUpdates.getState().check(true);
  };
  const first = window.setTimeout(run, 8000);
  const every = window.setInterval(run, 12 * HOUR);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(every);
  };
}
