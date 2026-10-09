import { useCallback, useEffect, useRef, useState } from "react";
import { AddFoldersHost } from "./components/AddFolders";
import { FilterBar } from "./components/FilterBar";
import { MenuHost } from "./components/Menu";
import { Editor } from "./components/Editor";
import { LabView } from "./components/lab/LabView";
import { onTransport } from "./store/lab";
import { MiniPlayer } from "./components/MiniPlayer";
import { DropTarget, Toasts, UpdateNotice } from "./components/Overlays";
import { PreviewPanel } from "./components/PreviewPanel";
import { ConfirmHost, PromptHost, useConfirm } from "./components/Prompt";
import { RecordPanel } from "./components/record/RecordPanel";
import { RenameHost } from "./components/Rename";
import { SampleList } from "./components/SampleList";
import { SelectionBar } from "./components/SelectionBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SoundMapView } from "./components/SoundMap";
import { TitleBar } from "./components/TitleBar";
import { TypeBar } from "./components/TypeBar";
import { Welcome } from "./components/Welcome";
import { WhatsNewHost, WhatsNewNotice } from "./components/WhatsNew";
import { useHotkeys } from "./hooks/useHotkeys";
import { useThemeSync } from "./hooks/useTheme";
import { initDragIcon, playNextAfter } from "./lib/actions";
import { api, errorMessage, events } from "./lib/api";
import { isTextInput } from "./lib/platform";
import { startBrowsing, useBrowse } from "./store/browse";
import { useLibrary } from "./store/library";
import { useEditor } from "./store/editor";
import { startParamsSync, usePlayer } from "./store/player";
import { usePrefs } from "./store/prefs";
import { stepRecording, useRecord } from "./store/record";
import { useSimilar } from "./store/similar";
import { useUi } from "./store/ui";
import { startUpdateChecks } from "./store/updates";
import { toast } from "./store/toasts";
import { startWhatsNew } from "./store/whatsNew";

/** Quitting with unsaved takes, when they go to the Trash on quit: say so before they do. */
function askAboutTakes(unsaved: number) {
  const takes = unsaved === 1 ? "1 unsaved take" : `${unsaved} unsaved takes`;
  useConfirm.getState().ask({
    title: `Move ${takes} to the Trash?`,
    body: "Saga moves unsaved takes to the Trash when it quits, as set in Settings › Recording. Takes you saved or dragged out stay in Recordings.",
    confirm: "Move to Trash and quit",
    danger: true,
    onConfirm: () => void api.quitApp(true).catch((e) => toast(errorMessage(e))),
    alternative: { label: "Keep them and quit", onSelect: () => void api.quitApp(false).catch((e) => toast(errorMessage(e))) },
  });
}

export default function App() {
  useThemeSync();
  const search = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState(false);
  const openSettings = useCallback(() => setSettings(true), []);
  useHotkeys(search, openSettings);
  const loaded = useLibrary((s) => s.loaded);
  const hasSources = useLibrary((s) => s.sources.length > 0);
  const editing = useEditor((s) => s.openId != null);
  const view = useUi((s) => s.view);
  const mini = useUi((s) => s.mini);
  const recordOpen = useRecord((s) => s.open);

  useEffect(() => {
    void useLibrary.getState().refresh();
    api.progress().then((p) => useLibrary.getState().setProgress(p)).catch(() => {});
    void initDragIcon();
    void api.setVolume(usePrefs.getState().volume);
    startBrowsing();
    const stopParamsSync = startParamsSync();
    const stopUpdateChecks = startUpdateChecks();
    void startWhatsNew();
    // Takes are known from the start, so a take previewed anywhere gets its Save and Delete.
    void useRecord.getState().loadTakes();
    void useRecord.getState().loadSettings();

    const subs = [
      events.onProgress((p) => useLibrary.getState().setProgress(p)),
      events.onLibraryChanged(() => {
        void useLibrary.getState().refresh();
        useBrowse.getState().refresh();
        useSimilar.getState().refreshIfWaiting();
        useRecord.getState().refreshRows();
      }),
      events.onPlayback((e) => {
        usePlayer.getState().handleEvent(e);
        if (e.state === "ended") void playNextAfter(e.id);
      }),
      events.onRecordLevel((e) => useSimilar.getState().onLevel(e)),
      events.onTransport(onTransport),
      events.onTakeStatus((e) => useRecord.getState().onStatus(e)),
      events.onTakeLanded((e) => useRecord.getState().onLanded(e)),
      events.onTakeNotice((e) => useRecord.getState().onNotice(e)),
      events.onRecordShortcut(() => stepRecording(true)),
      events.onQuitRequested(askAboutTakes),
    ];

    // A desktop app shouldn't offer the web view's Reload/Inspect menu.
    const noMenu = (e: MouseEvent) => {
      if (import.meta.env.PROD && !isTextInput(e.target)) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
    return () => {
      subs.forEach((p) => void p.then((unlisten) => unlisten()));
      window.removeEventListener("contextmenu", noMenu);
      stopParamsSync();
      stopUpdateChecks();
    };
  }, []);

  const overlays = (
    <>
      {/* First, so dialogs opened from Settings (confirmations, adding folders) stack above it. */}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      <WhatsNewHost />
      <MenuHost />
      <RenameHost />
      <AddFoldersHost />
      {/* After the dialogs, so a name asked for inside one (Save as preset…) shows above it. */}
      <PromptHost />
      <ConfirmHost />
      <Toasts />
      <UpdateNotice />
      <WhatsNewNotice />
      <DropTarget />
    </>
  );

  if (mini) {
    return (
      <>
        <MiniPlayer ref={search} />
        {overlays}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar ref={search} onOpenSettings={openSettings} />
      <div className="relative flex min-h-0 flex-1">
        {editing ? (
          <main className="@container flex min-w-0 flex-1 flex-col">
            <Editor />
          </main>
        ) : view === "lab" ? (
          <LabView />
        ) : (
          <>
            <Sidebar />
            <main className="@container flex min-w-0 flex-1 flex-col">
              {loaded && !hasSources ? (
                <Welcome />
              ) : view === "map" ? (
                <SoundMapView />
              ) : (
                <>
                  <TypeBar />
                  <FilterBar />
                  <div className="relative flex min-h-0 flex-1 flex-col">
                    <SampleList />
                    <SelectionBar />
                  </div>
                  <PreviewPanel />
                </>
              )}
            </main>
            {recordOpen && <RecordPanel />}
          </>
        )}
      </div>
      {overlays}
    </div>
  );
}
