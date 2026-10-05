import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";
import { compareVersions, releasesBetween } from "../lib/changelog";
import { useLibrary } from "./library";
import { usePrefs } from "./prefs";

interface WhatsNewState {
  /** The version running now, once known. */
  current: string | null;
  /** The versions the user hadn't read about when Saga opened, newest first. They stay marked for the session. */
  unread: string[];
  /** The version the user last read about, when they skipped some since. */
  since: string | null;
  /** The quiet card after an update is waiting to be read or put off. */
  notice: boolean;
  /** The What's new dialog is open. */
  open: boolean;
  show: () => void;
  close: () => void;
  /** "Later" on the card. The notes stay in Settings. */
  later: () => void;
}

/** Marks the running version as read, so the card shows once per version. */
function markSeen(current: string | null) {
  if (current) usePrefs.getState().set({ lastSeenVersion: current });
}

export const useWhatsNew = create<WhatsNewState>((set, get) => ({
  current: null,
  unread: [],
  since: null,
  notice: false,
  open: false,
  show: () => {
    markSeen(get().current);
    set({ open: true, notice: false });
  },
  close: () => set({ open: false }),
  later: () => {
    markSeen(get().current);
    set({ notice: false });
  },
}));

/**
 * Works out on launch whether Saga was just updated, and offers the notes if so. A fresh install says nothing (the
 * Welcome screen is enough), and neither does a downgrade or a version CHANGELOG.md has no notes for.
 */
export async function startWhatsNew(): Promise<void> {
  let current: string;
  try {
    current = await getVersion();
  } catch {
    return;
  }
  useWhatsNew.setState({ current });
  const seen = usePrefs.getState().lastSeenVersion;

  if (seen == null) {
    // Versions before this one didn't record what was read, so tell an update from a first run by the library: someone
    // updating already has folders in it.
    const library = await libraryLoaded();
    if (library.sources.length === 0) return markSeen(current);
  } else if (compareVersions(current, seen) <= 0) {
    return;
  }
  const unread = releasesBetween(seen, current).map((r) => r.version);
  if (unread[0] === current) useWhatsNew.setState({ unread, since: seen, notice: true });
}

function libraryLoaded(): Promise<ReturnType<typeof useLibrary.getState>> {
  return new Promise((resolve) => {
    if (useLibrary.getState().loaded) return resolve(useLibrary.getState());
    const stop = useLibrary.subscribe((s) => {
      if (!s.loaded) return;
      stop();
      resolve(s);
    });
  });
}
