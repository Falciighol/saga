import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../lib/api";
import { applyFonts, monoStack, sansStack } from "../lib/fonts";
import { measurePixelRatio } from "../lib/scale";
import { applyPalette, palette, type Palette, type ResolvedTheme } from "../lib/theme";
import { usePrefs } from "../store/prefs";
import { toast } from "../store/toasts";

const usePaletteStore = create<{ palette: Palette; theme: ResolvedTheme }>(() => ({
  palette: palette("dark", "violet"),
  theme: "dark",
}));

/** Current colors, for canvas drawing. */
export const usePalette = () => usePaletteStore((s) => s.palette);

/** Dark or light, after following the system setting. */
export const useResolvedTheme = () => usePaletteStore((s) => s.theme);

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies the theme (following the OS when set to system), font and interface size preferences. */
export function useThemeSync() {
  const pref = usePrefs((s) => s.theme);
  const accent = usePrefs((s) => s.accent);
  const sans = usePrefs((s) => sansStack(s.sansFont, s.sansInstalled));
  const mono = usePrefs((s) => monoStack(s.monoFont, s.monoInstalled));
  const uiScale = usePrefs((s) => s.uiScale);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const theme = pref === "system" ? system : pref;
    const p = palette(theme, accent);
    applyPalette(p, theme);
    usePaletteStore.setState({ palette: p, theme });
  }, [pref, accent, system]);

  useEffect(() => applyFonts(sans, mono), [sans, mono]);

  useEffect(() => {
    api
      .setUiScale(uiScale)
      .then(() => measurePixelRatio(uiScale))
      .catch((e) => toast(errorMessage(e)));
    // The zoom lands a moment after the call returns, and moving to another screen changes
    // the ratio too; both resize the page.
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void measurePixelRatio(uiScale));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [uiScale]);
}
