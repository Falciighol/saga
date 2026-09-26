import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { isWindows } from "../lib/platform";
import { cx } from "./ui";

// Glyphs from the font Windows draws its own caption buttons with (MDL2 Assets on Windows 10).
const MINIMIZE = "\uE921";
const MAXIMIZE = "\uE922";
const RESTORE = "\uE923";
const CLOSE = "\uE8BB";

function CaptionButton({ label, glyph, close, onClick }: { label: string; glyph: string; close?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onClick={onClick}
      className={cx(
        "grid h-full w-[46px] shrink-0 place-items-center font-['Segoe_Fluent_Icons','Segoe_MDL2_Assets'] text-[10px] text-[inherit] transition-colors duration-100",
        close ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90 active:text-white/80" : "hover:bg-text/8 active:bg-text/5 active:text-text2",
      )}
    >
      {glyph}
    </button>
  );
}

/** Minimize, maximize and close, drawn like the system's own since the window has no title bar on Windows. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!isWindows) return;
    const win = getCurrentWindow();
    const sync = () => win.isMaximized().then((m) => setMaximized(!!m), () => {});
    sync();
    const unlisten = [win.onResized(sync), win.onFocusChanged(({ payload }) => setFocused(payload))];
    return () => unlisten.forEach((p) => p.then((f) => f(), () => {}));
  }, []);

  if (!isWindows) return null;
  const win = getCurrentWindow();
  return (
    <div className={cx("flex h-full shrink-0 self-stretch", focused ? "text-text" : "text-text3")}>
      <CaptionButton label="Minimize" glyph={MINIMIZE} onClick={() => win.minimize()} />
      <CaptionButton label={maximized ? "Restore Down" : "Maximize"} glyph={maximized ? RESTORE : MAXIMIZE} onClick={() => win.toggleMaximize()} />
      <CaptionButton label="Close" glyph={CLOSE} close onClick={() => win.close()} />
    </div>
  );
}
