import { useCallback, useEffect, useRef, useState } from "react";
import { FilterBar } from "./components/FilterBar";
import { MenuHost } from "./components/Menu";
import { Editor } from "./components/Editor";
import { LabView } from "./components/lab/LabView";
import { onTransport } from "./store/lab";
import { MiniPlayer } from "./components/MiniPlayer";
import { DropTarget, Toasts } from "./components/Overlays";
import { PreviewPanel } from "./components/PreviewPanel";
import { PromptHost } from "./components/Prompt";
import { ListHeader, SampleList } from "./components/SampleList";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SoundMapView } from "./components/SoundMap";
import { TitleBar } from "./components/TitleBar";
import { TypeBar } from "./components/TypeBar";
import { Welcome } from "./components/Welcome";
import { useHotkeys } from "./hooks/useHotkeys";
import { useThemeSync } from "./hooks/useTheme";
import { initDragIcon } from "./lib/actions";
import { api, events } from "./lib/api";
import { isTextInput } from "./lib/platform";
import { startBrowsing, useBrowse } from "./store/browse";
import { useLibrary } from "./store/library";
import { useEditor } from "./store/editor";
import { startParamsSync, usePlayer } from "./store/player";
import { usePrefs } from "./store/prefs";
import { useSimilar } from "./store/similar";
import { useUi } from "./store/ui";

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

  useEffect(() => {
    void useLibrary.getState().refresh();
    api.progress().then((p) => useLibrary.getState().setProgress(p)).catch(() => {});
    void initDragIcon();
    void api.setVolume(usePrefs.getState().volume);
    startBrowsing();
    const stopParamsSync = startParamsSync();

    const subs = [
      events.onProgress((p) => useLibrary.getState().setProgress(p)),
      events.onLibraryChanged(() => {
        void useLibrary.getState().refresh();
        useBrowse.getState().refresh();
        useSimilar.getState().refreshIfWaiting();
      }),
      events.onPlayback((e) => usePlayer.getState().handleEvent(e)),
      events.onRecordLevel((e) => useSimilar.getState().onLevel(e)),
      events.onTransport(onTransport),
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
    };
  }, []);

  const overlays = (
    <>
      <MenuHost />
      <PromptHost />
      <Toasts />
      <DropTarget />
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
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
      <div className="flex min-h-0 flex-1">
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
                  <ListHeader />
                  <SampleList />
                  <PreviewPanel />
                </>
              )}
            </main>
          </>
        )}
      </div>
      {overlays}
    </div>
  );
}
