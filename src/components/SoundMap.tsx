import { Headphones, Lasso, Minus, Plus, Scan, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePalette, useResolvedTheme } from "../hooks/useTheme";
import { collectionSubmenu } from "../lib/actions";
import { api, events } from "../lib/api";
import { fmtCount } from "../lib/format";
import { cellOf, GRID, MAP_GROUPS, sequential, type MapData } from "../lib/soundmap";
import { usePixelRatio } from "../lib/scale";
import type { SampleRow } from "../lib/types";
import { setupCanvas } from "../lib/waveform";
import { activeFilterCount, useBrowse } from "../store/browse";
import { usePlayer } from "../store/player";
import { usePrefs, type MapArrange, type MapColor, type MapDrag } from "../store/prefs";
import { useSimilar } from "../store/similar";
import { useSoundMap } from "../store/soundmap";
import { openMenuBelow } from "./Menu";
import { useElementWidth } from "./PreviewPanel";
import { SimilarPanel } from "./SimilarPanel";
import { cx, Divider, Segmented } from "./ui";
import { ViewToggle } from "./ViewToggle";

interface View {
  zoom: number;
  /** Map point at the middle of the canvas, in 0–1. */
  cx: number;
  cy: number;
}

const FIT: View = { zoom: 1, cx: 0.5, cy: 0.5 };
const MAX_ZOOM = 40;
/** The layout is square; a wider or taller canvas spreads it out this much at most. */
const MAX_STRETCH = 1.6;
/** The glow under the dots is soft, so it's painted at half size and scaled up: a fraction of the fill work on a big library. */
const GLOW_SCALE = 0.5;
/** How many of the closest matches get linked to the selected sound. */
const LINKS = 8;
const TAU = Math.PI * 2;

const rowCache = new Map<number, SampleRow>();
const rowRequests = new Map<number, Promise<SampleRow | null>>();

/** Sample rows for map points, fetched once. */
function getRow(id: number): Promise<SampleRow | null> {
  const hit = rowCache.get(id);
  if (hit) return Promise.resolve(hit);
  let req = rowRequests.get(id);
  if (!req) {
    req = api
      .sample(id)
      .then((row) => {
        if (row) rowCache.set(id, row);
        if (rowCache.size > 2000) rowCache.clear();
        return row;
      })
      .catch(() => null)
      .finally(() => rowRequests.delete(id));
    rowRequests.set(id, req);
  }
  return req;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Screen pixels per map unit, across and down. */
function mapScale(width: number, height: number, zoom: number): [number, number] {
  const short = Math.max(50, Math.min(width, height) * 0.9) * zoom;
  const stretch = Math.min(MAX_STRETCH, Math.max(width, height) / Math.max(1, Math.min(width, height)));
  return width >= height ? [short * stretch, short] : [short, short * stretch];
}

/** Dots grow with the room each sound has, so a small library doesn't look like dust and a big one doesn't smear. */
function dotRadius(zoom: number, count: number, area: number): number {
  const base = Math.min(4, Math.max(2.2, 0.085 * Math.sqrt(area / Math.max(1, count))));
  return Math.min(7, base * Math.pow(zoom, 0.3));
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Keeps the map in step with the browser's type, search and filters, and with the library. */
function useMapSync() {
  useEffect(() => {
    const map = useSoundMap.getState;
    void map().load();
    let matchTimer: number | undefined;
    const unsubBrowse = useBrowse.subscribe((s, prev) => {
      if (s.kind !== prev.kind) {
        void map().load();
      } else if (s.text !== prev.text || s.filters !== prev.filters || s.categories !== prev.categories || s.view !== prev.view) {
        window.clearTimeout(matchTimer);
        matchTimer = window.setTimeout(() => void map().refreshMatches(), 160);
      }
    });
    const unsubPrefs = usePrefs.subscribe((p, prev) => {
      if (p.mapArrange !== prev.mapArrange) void map().load();
    });
    // While indexing, the library changes constantly; pick up new sounds every few seconds.
    let last = Date.now();
    let reloadTimer: number | undefined;
    const lib = events.onLibraryChanged(() => {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        last = Date.now();
        void map().load();
      }, Math.max(300, last + 5000 - Date.now()));
    });
    return () => {
      unsubBrowse();
      unsubPrefs();
      window.clearTimeout(matchTimer);
      window.clearTimeout(reloadTimer);
      void lib.then((u) => u());
    };
  }, []);
}

function MapToolbar() {
  const kind = useBrowse((s) => s.kind);
  const setKind = useBrowse((s) => s.setKind);
  const facets = useBrowse((s) => s.facets);
  const mapColor = usePrefs((s) => s.mapColor);
  const mapArrange = usePrefs((s) => s.mapArrange);
  const setPrefs = usePrefs((s) => s.set);
  const data = useSoundMap((s) => s.data);
  const [bar, barWidth] = useElementWidth<HTMLDivElement>();
  // At the narrowest window sizes the three switches get smaller rather than pushing the view toggle off.
  const size = barWidth > 0 && barWidth < 860 ? "sm" : "md";
  const count = (n: number | undefined) => n != null && <span className="font-mono text-micro font-normal text-text3 tabular @max-[1080px]:hidden">{fmtCount(n)}</span>;
  const noun = kind === "loop" ? "loops" : kind === "oneshot" ? "one-shots" : "sounds";
  return (
    <div ref={bar} className="flex h-[52px] shrink-0 items-center gap-3 px-4">
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
        <Segmented
          size={size}
          label="Sample type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "oneshot", label: <>One-shots {count(facets?.oneshots)}</> },
            { value: "loop", label: <>Loops {count(facets?.loops)}</> },
          ]}
        />
        <Divider className="@max-[1000px]:hidden" />
        <span className="text-ui text-text3 @max-[1180px]:hidden">Color by</span>
        <Segmented<MapColor>
          size={size}
          label="Color by"
          value={mapColor}
          onChange={(v) => setPrefs({ mapColor: v })}
          options={[
            { value: "category", label: "Category" },
            { value: "brightness", label: "Brightness", title: "Dark to bright sounds" },
            { value: "loudness", label: "Loudness", title: "Quiet to loud" },
          ]}
        />
        <span className="ml-1 text-ui text-text3 @max-[1180px]:hidden">Arrange by</span>
        <Segmented<MapArrange>
          size={size}
          label="Arrange by"
          value={mapArrange}
          onChange={(v) => setPrefs({ mapArrange: v })}
          options={[
            { value: "timbre", label: "Timbre", title: "Tone color: dark or bright, clean or noisy" },
            { value: "pitch", label: "Pitch", title: "Which notes, and how high" },
            { value: "envelope", label: "Envelope", title: "Attack, length and decay" },
          ]}
        />
      </div>
      {data && (
        <span className="shrink-0 font-mono text-small text-text3 tabular @max-[1100px]:hidden">
          {fmtCount(data.count)} {noun}
        </span>
      )}
      <ViewToggle />
    </div>
  );
}

/** The name of the sound under the pointer. Everything else about it is in the Similar sounds panel. */
function MapLabel({ name, x, y, bounds }: { name: string; x: number; y: number; bounds: { width: number; height: number } }) {
  // Beside the point, on whichever side has room.
  const side = x > bounds.width - 260 ? { right: bounds.width - x + 14 } : { left: x + 14 };
  return (
    <span
      className="pointer-events-none absolute z-10 max-w-[240px] truncate rounded-md border border-line2 bg-raised px-2 text-small leading-[22px] font-medium shadow-pop"
      style={{ ...side, top: Math.min(bounds.height - 30, Math.max(8, y - 11)) }}
    >
      {name}
    </span>
  );
}

function MapCanvas() {
  useMapSync();
  const [box, size] = useElementSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useSoundMap((s) => s.data);
  const loading = useSoundMap((s) => s.loading);
  const error = useSoundMap((s) => s.error);
  const matches = useSoundMap((s) => s.matches);
  const matched = useSoundMap((s) => s.matched);
  const selection = useSoundMap((s) => s.selection);
  const isolate = useSoundMap((s) => s.isolate);
  const colorBy = usePrefs((s) => s.mapColor);
  const theme = useResolvedTheme();
  const colors = usePalette();
  const ratio = usePixelRatio();
  const target = useSimilar((s) => s.target);
  const items = useSimilar((s) => s.items);
  const simIndex = useSimilar((s) => s.index);
  const playingId = usePlayer((s) => (s.status === "idle" ? null : s.id));
  const sounding = usePlayer((s) => s.status === "playing");
  const dragMode = usePrefs((s) => s.mapDrag);
  const [view, setView] = useState<View>(FIT);
  const [hover, setHover] = useState(-1);
  const [hoverRow, setHoverRow] = useState<SampleRow | null>(null);
  const [lassoBox, setLassoBox] = useState<{ x: number; y: number } | null>(null);
  /** `heard`: the last point played while dragging to audition. */
  const drag = useRef<{ mode: "pending" | "lasso" | "audition" | "pan"; x0: number; y0: number; view0: View; pts: [number, number][]; hit: number; heard: number } | null>(null);
  const raf = useRef(0);
  const glow = useRef<HTMLCanvasElement | null>(null);
  const auditionSeq = useRef(0);
  const narrowed = useBrowse((s) => s.text.trim() !== "" || activeFilterCount(s.filters) > 0 || s.categories.length > 0 || s.view.type !== "all");

  const { width, height } = size;
  const [kx, ky] = mapScale(width, height, view.zoom);
  const radius = dotRadius(view.zoom, data?.count ?? 0, width * height);
  const toScreen = useCallback((x: number, y: number): [number, number] => [width / 2 + (x - view.cx) * kx, height / 2 + (y - view.cy) * ky], [width, height, view, kx, ky]);

  const targetIndex = target?.kind === "sample" && data ? (data.index.get(target.row.id) ?? -1) : -1;
  const linked = useMemo(() => (data ? items.slice(0, LINKS).map((i) => data.index.get(i.row.id) ?? -1).filter((i) => i >= 0) : []), [items, data]);
  const highlighted = data && simIndex >= 0 && items[simIndex] ? (data.index.get(items[simIndex].row.id) ?? -1) : -1;
  const selectedSet = useMemo(() => new Set(selection), [selection]);

  const ramp = useMemo(() => sequential(theme, 16), [theme]);
  const colorOf = useCallback(
    (d: MapData, i: number) => {
      if (colorBy === "brightness") return ramp[d.bright[i] >> 4];
      if (colorBy === "loudness") return ramp[d.level[i] >> 4];
      const g = MAP_GROUPS[d.group[i]] ?? MAP_GROUPS[MAP_GROUPS.length - 1];
      return theme === "dark" ? g.dark : g.light;
    },
    [colorBy, ramp, theme],
  );

  // A new arrangement (not just new sounds joining this one) starts from the whole map.
  const layoutName = data?.key.replace(/-\d+$/, "");
  useEffect(() => {
    setView(FIT);
  }, [layoutName]);

  const visible = useCallback((d: MapData, i: number) => (!matches || matches[i] === 1) && (isolate == null || d.group[i] === isolate), [matches, isolate]);

  const hitTest = useCallback(
    (px: number, py: number): number => {
      if (!data) return -1;
      const nx = view.cx + (px - width / 2) / kx;
      const ny = view.cy + (py - height / 2) / ky;
      // In screen pixels: a little beyond the dot itself.
      const reach = Math.max(10, radius + 5);
      const c0 = cellOf(nx - reach / kx, ny - reach / ky);
      const c1 = cellOf(nx + reach / kx, ny + reach / ky);
      const [x0, y0, x1, y1] = [c0 % GRID, Math.floor(c0 / GRID), c1 % GRID, Math.floor(c1 / GRID)];
      let best = -1;
      let bestD = reach * reach;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cxx = x0; cxx <= x1; cxx++) {
          for (const i of data.grid[cy * GRID + cxx]) {
            if (!visible(data, i)) continue;
            const d = ((data.x[i] - nx) * kx) ** 2 + ((data.y[i] - ny) * ky) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      return best;
    },
    [data, view, width, height, kx, ky, radius, visible],
  );

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c || !width || !height) return;
    const ctx = setupCanvas(c, width, height);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (!data) return;
    const r = radius;
    // Two soft rings under each dot: neighbours of a color pool into a glow, so clusters read as places.
    const [near, far] = [r * 2, r * 3.4];
    const dim = new Path2D();
    const byColor = new Map<string, { dots: Path2D; near: Path2D; far: Path2D }>();
    for (let i = 0; i < data.count; i++) {
      const [sx, sy] = toScreen(data.x[i], data.y[i]);
      if (sx < -far || sy < -far || sx > width + far || sy > height + far) continue;
      if (!visible(data, i)) {
        dim.moveTo(sx + r * 0.8, sy);
        dim.arc(sx, sy, r * 0.8, 0, TAU);
        continue;
      }
      const color = colorOf(data, i);
      let p = byColor.get(color);
      if (!p) byColor.set(color, (p = { dots: new Path2D(), near: new Path2D(), far: new Path2D() }));
      p.dots.moveTo(sx + r, sy);
      p.dots.arc(sx, sy, r, 0, TAU);
      p.near.moveTo(sx + near, sy);
      p.near.arc(sx, sy, near, 0, TAU);
      p.far.moveTo(sx + far, sy);
      p.far.arc(sx, sy, far, 0, TAU);
    }
    ctx.globalAlpha = theme === "dark" ? 0.35 : 0.45;
    ctx.fillStyle = colors.wave;
    ctx.fill(dim);
    const layer = (glow.current ??= document.createElement("canvas"));
    const [gw, gh] = [Math.ceil(width * GLOW_SCALE), Math.ceil(height * GLOW_SCALE)];
    if (layer.width !== gw || layer.height !== gh) {
      layer.width = gw;
      layer.height = gh;
    }
    const g = layer.getContext("2d");
    if (g) {
      g.setTransform(GLOW_SCALE, 0, 0, GLOW_SCALE, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.clearRect(0, 0, width, height);
      // On dark, glows add up like light; on light they tint the paper.
      g.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";
      for (const [color, p] of byColor) {
        g.fillStyle = color;
        g.globalAlpha = theme === "dark" ? 0.07 : 0.06;
        g.fill(p.far);
        g.globalAlpha = theme === "dark" ? 0.13 : 0.1;
        g.fill(p.near);
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(layer, 0, 0, gw / GLOW_SCALE, gh / GLOW_SCALE);
    }
    ctx.globalAlpha = 0.95;
    for (const [color, p] of byColor) {
      ctx.fillStyle = color;
      ctx.fill(p.dots);
    }
    ctx.globalAlpha = 1;

    const ring = (i: number, extra: number, width_: number, color = colors.text) => {
      const [sx, sy] = toScreen(data.x[i], data.y[i]);
      ctx.beginPath();
      ctx.arc(sx, sy, r + extra, 0, TAU);
      ctx.strokeStyle = color;
      ctx.lineWidth = width_;
      ctx.stroke();
    };
    if (selectedSet.size) {
      for (const id of selectedSet) {
        const i = data.index.get(id);
        if (i != null) ring(i, 1.5, 1.25);
      }
    }
    if (targetIndex >= 0) {
      const [tx, ty] = toScreen(data.x[targetIndex], data.y[targetIndex]);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colors.text;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const i of linked) {
        const [sx, sy] = toScreen(data.x[i], data.y[i]);
        ctx.moveTo(tx, ty);
        ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // The closest matches get rings, also for a recording or a dropped file (which have no point).
    for (const i of linked) ring(i, 2.2, i === highlighted ? 2 : 1.5);
    if (highlighted >= 0 && !linked.includes(highlighted)) ring(highlighted, 2.2, 2);
    const playingIndex = playingId != null ? (data.index.get(playingId) ?? -1) : -1;
    if (playingIndex >= 0 && playingIndex !== targetIndex) ring(playingIndex, 3, 2, colors.accentWave);
    if (targetIndex >= 0) {
      const [tx, ty] = toScreen(data.x[targetIndex], data.y[targetIndex]);
      ctx.beginPath();
      ctx.arc(tx, ty, r + 4, 0, TAU);
      ctx.fillStyle = colorOf(data, targetIndex);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colors.text;
      ctx.stroke();
    }
    if (hover >= 0 && hover !== targetIndex) ring(hover, 2, 2);
    const lasso = drag.current?.mode === "lasso" ? drag.current.pts : null;
    if (lasso && lasso.length > 1) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = colors.text2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      lasso.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [data, width, height, radius, toScreen, visible, colorOf, colors, ratio, theme, selectedSet, targetIndex, linked, highlighted, hover, playingId]);

  const requestDraw = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(draw);
  }, [draw]);
  useEffect(() => {
    requestDraw();
    return () => cancelAnimationFrame(raf.current);
  }, [requestDraw]);

  // Bring the selected sound into view when it's off screen.
  useEffect(() => {
    if (!data || targetIndex < 0 || !width) return;
    const [sx, sy] = toScreen(data.x[targetIndex], data.y[targetIndex]);
    if (sx < 40 || sy < 40 || sx > width - 40 || sy > height - 40) setView((v) => ({ ...v, cx: data.x[targetIndex], cy: data.y[targetIndex] }));
    // Only when the target (or the arrangement) changes, not while panning.
  }, [targetIndex, data?.key]);

  const tipId = data && hover >= 0 ? data.ids[hover] : null;
  useEffect(() => {
    if (tipId == null) {
      setHoverRow(null);
      return;
    }
    let live = true;
    const cached = rowCache.get(tipId);
    if (cached) setHoverRow(cached);
    else {
      const t = window.setTimeout(() => getRow(tipId).then((row) => live && setHoverRow(row)), 60);
      return () => {
        live = false;
        window.clearTimeout(t);
      };
    }
  }, [tipId]);

  // The panel beside the map shows the sound under the pointer. Passing from one dot to the
  // next shouldn't make it blink, so it lingers a moment after the pointer leaves.
  const hoverColor = hoverRow && data && hover >= 0 && data.ids[hover] === hoverRow.id ? colorOf(data, hover) : null;
  useEffect(() => {
    const { setHovered } = useSoundMap.getState();
    if (hoverRow && hoverColor) {
      setHovered({ row: hoverRow, color: hoverColor });
      return;
    }
    const t = window.setTimeout(() => setHovered(null), 140);
    return () => window.clearTimeout(t);
  }, [hoverRow, hoverColor]);
  useEffect(() => () => useSoundMap.getState().setHovered(null), []);

  const zoomAt = useCallback(
    (factor: number, px = width / 2, py = height / 2) => {
      setView((v) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom * factor));
        const [x0, y0] = mapScale(width, height, v.zoom);
        const [x1, y1] = mapScale(width, height, zoom);
        // Keep the map point under the pointer where it is.
        const nx = v.cx + (px - width / 2) / x0;
        const ny = v.cy + (py - height / 2) / y0;
        return zoom === 1 ? FIT : { zoom, cx: nx - (px - width / 2) / x1, cy: ny - (py - height / 2) / y1 };
      });
    },
    [width, height],
  );

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => {
          const [sx, sy] = mapScale(width, height, v.zoom);
          return { ...v, cx: v.cx + e.deltaX / sx, cy: v.cy + e.deltaY / sy };
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, width, height]);

  const local = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const pick = (i: number, play = true) => {
    if (!data) return;
    void getRow(data.ids[i]).then((row) => {
      if (!row) return;
      useBrowse.getState().selectRow(row, -1, { play });
      useSimilar.getState().find(row);
    });
  };

  /** Plays a sound in passing, while dragging across the map. */
  const audition = (i: number) => {
    if (!data) return;
    const mine = ++auditionSeq.current;
    void getRow(data.ids[i]).then((row) => {
      // Only the latest: a row that arrives late shouldn't cut off the sound under the pointer now.
      if (row && mine === auditionSeq.current) usePlayer.getState().play(row);
    });
  };

  const finishLasso = (pts: [number, number][]) => {
    if (!data || pts.length < 4) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const ids: number[] = [];
    for (let i = 0; i < data.count; i++) {
      if (!visible(data, i)) continue;
      const [sx, sy] = toScreen(data.x[i], data.y[i]);
      if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
      if (pointInPolygon(sx, sy, pts)) ids.push(data.ids[i]);
    }
    useSoundMap.getState().setSelection(ids);
    setLassoBox(ids.length ? { x: (x0 + x1) / 2, y: y1 } : null);
  };

  const groupsPresent = useMemo(() => {
    if (!data) return [];
    const seen = new Set<number>();
    for (let i = 0; i < data.count; i++) seen.add(data.group[i]);
    return MAP_GROUPS.map((g, i) => ({ ...g, index: i })).filter((g) => seen.has(g.index));
  }, [data]);

  const cursor = drag.current?.mode === "pan" ? "grabbing" : hover >= 0 ? "pointer" : "crosshair";
  const empty = data && data.count === 0;
  const tip = hoverRow && hover >= 0 && data && hoverRow.id === data.ids[hover] ? toScreen(data.x[hover], data.y[hover]) : null;
  const playingIndex = data && sounding && playingId != null ? (data.index.get(playingId) ?? -1) : -1;
  const pulse = data && playingIndex >= 0 ? toScreen(data.x[playingIndex], data.y[playingIndex]) : null;
  const setDragMode = (mapDrag: MapDrag) => usePrefs.getState().set({ mapDrag });

  return (
    <div ref={box} className="relative min-w-0 flex-1 overflow-hidden">
      <canvas
        ref={canvas}
        role="img"
        aria-label={data ? `Sound map of ${fmtCount(data.count)} sounds, arranged so similar ones sit together. Use the Similar sounds list to browse by keyboard.` : "Sound map"}
        style={{ width, height, cursor }}
        className="absolute inset-0 block touch-none"
        onPointerDown={(e) => {
          if (e.button === 2) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const [x, y] = local(e);
          drag.current = { mode: e.button === 1 || e.altKey ? "pan" : "pending", x0: x, y0: y, view0: view, pts: [[x, y]], hit: hitTest(x, y), heard: -1 };
        }}
        onPointerMove={(e) => {
          const [x, y] = local(e);
          const d = drag.current;
          if (!d) {
            const h = hitTest(x, y);
            if (h !== hover) setHover(h);
            return;
          }
          if (d.mode === "pending" && Math.hypot(x - d.x0, y - d.y0) > 4) {
            // Dragging plays the sounds it passes or draws a lasso, and Shift swaps the two;
            // scrolling (or Alt-drag) moves the map.
            d.mode = (dragMode === "lasso") !== e.shiftKey ? "lasso" : "audition";
            if (d.mode === "lasso") {
              setHover(-1);
              setLassoBox(null);
            }
          }
          if (d.mode === "pan") {
            setView({ ...d.view0, cx: d.view0.cx - (x - d.x0) / kx, cy: d.view0.cy - (y - d.y0) / ky });
          } else if (d.mode === "lasso") {
            d.pts.push([x, y]);
            requestDraw();
          } else if (d.mode === "audition") {
            const h = hitTest(x, y);
            if (h !== hover) setHover(h);
            if (h >= 0 && h !== d.heard) {
              d.heard = h;
              audition(h);
            }
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.mode === "pending") {
            if (d.hit >= 0) pick(d.hit);
            else {
              useSoundMap.getState().setSelection([]);
              setLassoBox(null);
            }
          } else if (d.mode === "lasso") {
            finishLasso(d.pts);
          } else if (d.mode === "audition" && d.heard >= 0) {
            // The last sound heard stays selected (it's already playing).
            pick(d.heard, false);
          }
          requestDraw();
        }}
        onPointerLeave={() => !drag.current && setHover(-1)}
      />

      {data && !empty && (
        <div className="pointer-events-none absolute inset-0">
          {data.labels.map((l) => {
            const [sx, sy] = toScreen(l.x, l.y);
            if (sx < -60 || sy < -20 || sx > width + 60 || sy > height + 20 || (isolate != null && isolate !== l.group)) return null;
            return (
              <span
                key={l.group}
                className="absolute flex -translate-x-1/2 items-baseline gap-1.5 rounded px-1 text-small font-medium whitespace-nowrap text-text2"
                style={{ left: sx, top: sy - 38, background: "color-mix(in srgb, var(--bg) 70%, transparent)" }}
              >
                {MAP_GROUPS[l.group]?.name}
                <span className="font-mono text-micro font-normal text-text3">{fmtCount(l.count)}</span>
              </span>
            );
          })}
        </div>
      )}

      {pulse && (
        <span
          aria-hidden="true"
          className="animate-map-ping pointer-events-none absolute rounded-full border-2 border-accent-wave"
          style={{ left: pulse[0] - radius - 4, top: pulse[1] - radius - 4, width: (radius + 4) * 2, height: (radius + 4) * 2 }}
        />
      )}

      {tip && hoverRow && <MapLabel name={hoverRow.name} x={tip[0]} y={tip[1]} bounds={size} />}

      <div className="absolute top-3 left-4 flex max-w-[calc(100%-32px)] flex-col items-start gap-2">
        {data && narrowed && (
          <div className="flex items-center gap-2.5 rounded-lg border border-line2 bg-raised py-1 pr-1 pl-3 text-small text-text2">
            <span>
              <span className="font-mono text-text tabular">{fmtCount(matches ? matched : data.count)}</span> of {fmtCount(data.count)} match your search and filters
            </span>
            <button
              type="button"
              onClick={() => {
                const b = useBrowse.getState();
                b.setText("");
                b.clearAll();
                if (b.view.type !== "all") b.setView({ type: "all" });
              }}
              className="h-6 rounded-md px-2 text-small text-text hover:bg-raised2"
            >
              Show all
            </button>
          </div>
        )}
        {data && data.pending > 0 && (
          <span className="rounded-md bg-bg/80 px-1.5 text-small text-text3">
            Listening to {fmtCount(data.pending)} more {data.pending === 1 ? "sample" : "samples"}; they join the map as they're analyzed.
          </span>
        )}
      </div>

      {lassoBox && selection.length > 0 && (
        <div
          className="absolute z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line2 bg-raised py-1 pr-1 pl-2.5 shadow-pop"
          style={{ left: Math.min(width - 150, Math.max(150, lassoBox.x)), top: Math.min(height - 48, lassoBox.y + 10) }}
        >
          <span className="text-small whitespace-nowrap text-text2">
            <span className="font-mono text-text">{fmtCount(selection.length)}</span> selected
          </span>
          <button type="button" onClick={(e) => openMenuBelow(e.currentTarget, collectionSubmenu(selection))} className="h-[26px] rounded-md bg-seg px-2.5 text-small whitespace-nowrap hover:bg-raised2">
            Add to collection
          </button>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => {
              useSoundMap.getState().setSelection([]);
              setLassoBox(null);
            }}
            className="grid h-[26px] w-[26px] place-items-center rounded-md text-text3 hover:bg-raised2 hover:text-text"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {data && !empty && (
        <div className="absolute bottom-4 left-4 flex max-w-[calc(100%-96px)] flex-wrap items-center gap-x-3 gap-y-1.5">
          {colorBy === "category" ? (
            groupsPresent.map((g) => {
              const on = isolate === g.index;
              return (
                <button
                  key={g.name}
                  type="button"
                  aria-pressed={on}
                  title={on ? "Show every category" : `Show only ${g.name.toLowerCase()}`}
                  onClick={() => useSoundMap.getState().setIsolate(on ? null : g.index)}
                  className={cx(
                    "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-small whitespace-nowrap transition-colors",
                    on ? "bg-raised2 text-text" : isolate != null ? "text-text3 hover:text-text2" : "text-text2 hover:text-text",
                  )}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: theme === "dark" ? g.dark : g.light }} />
                  {g.name}
                </button>
              );
            })
          ) : (
            <div className="flex items-center gap-2 text-small text-text2">
              <span>{colorBy === "brightness" ? "Dark" : "Quiet"}</span>
              <span className="h-2 w-28 rounded-full" style={{ background: `linear-gradient(90deg, ${ramp.join(", ")})` }} />
              <span>{colorBy === "brightness" ? "Bright" : "Loud"}</span>
            </div>
          )}
        </div>
      )}

      {data && !empty && (
        <div className="absolute right-4 bottom-4 flex flex-col gap-2">
          <div role="group" aria-label="Dragging on the map" className="flex flex-col gap-0.5 rounded-lg border border-line2 bg-raised p-[3px]">
            {(
              [
                ["audition", "Drag to hear", "Drag across the map to hear each sound you pass. Shift-drag lassos instead.", <Headphones key="i" size={14} strokeWidth={2} />],
                ["lasso", "Drag to lasso", "Drag around sounds to select them. Shift-drag plays them instead.", <Lasso key="i" size={14} strokeWidth={2} />],
              ] as const
            ).map(([mode, label, title, icon]) => (
              <button
                key={mode}
                type="button"
                aria-label={label}
                aria-pressed={dragMode === mode}
                title={title}
                onClick={() => setDragMode(mode)}
                className={cx("grid h-7 w-7 place-items-center rounded-md", dragMode === mode ? "bg-seg text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-text2 hover:bg-raised2 hover:text-text")}
              >
                {icon}
              </button>
            ))}
          </div>
          <div title="Scroll or Alt-drag to move around; ⌘-scroll or pinch to zoom" className="flex flex-col gap-0.5 rounded-lg border border-line2 bg-raised p-[3px]">
            <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.6)} className="grid h-7 w-7 place-items-center rounded-md text-text2 hover:bg-raised2 hover:text-text">
              <Plus size={14} strokeWidth={2} />
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.6)} className="grid h-7 w-7 place-items-center rounded-md text-text2 hover:bg-raised2 hover:text-text">
              <Minus size={14} strokeWidth={2} />
            </button>
            <button type="button" aria-label="Fit map" title="Show the whole map" onClick={() => setView(FIT)} className="grid h-7 w-7 place-items-center rounded-md text-text2 hover:bg-raised2 hover:text-text">
              <Scan size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {(!data || empty) && (
        <div className="absolute inset-0 grid place-items-center p-8 text-center">
          <div className="flex max-w-[380px] flex-col items-center gap-2.5">
            {error ? (
              <>
                <span className="text-[14px] font-medium">Couldn't arrange the map</span>
                <span className="text-ui text-text3">{error}</span>
                <button type="button" onClick={() => void useSoundMap.getState().load()} className="mt-1 h-[30px] rounded-lg border border-line2 px-3 text-ui hover:bg-raised">
                  Try again
                </button>
              </>
            ) : loading || !data ? (
              <span className="animate-soft-pulse text-ui text-text2">Arranging your sounds…</span>
            ) : data.pending > 0 ? (
              <>
                <span className="text-[14px] font-medium">Saga is listening to your samples</span>
                <span className="text-ui text-text3">
                  The map fills in as each one is analyzed. {fmtCount(data.pending)} to go.
                </span>
              </>
            ) : (
              <>
                <span className="text-[14px] font-medium">No sounds to map yet</span>
                <span className="text-ui text-text3">Samples appear here once they're indexed. Try switching between one-shots and loops.</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Similar sounds laid out as a map, with the Similar sounds list beside it. */
export function SoundMapView() {
  return (
    <>
      <MapToolbar />
      <div className="flex min-h-0 flex-1 border-t border-line">
        <MapCanvas />
        <SimilarPanel />
      </div>
    </>
  );
}
