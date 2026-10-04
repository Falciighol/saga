import { open } from "@tauri-apps/plugin-dialog";
import { AudioLines, ChevronDown, ChevronRight, Clock, Folder, FolderMinus, FolderPlus, HardDrive, Plus, RefreshCw, Sparkle, Star, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { newCollection, reveal } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { fmtCount } from "../lib/format";
import { revealLabel } from "../lib/platform";
import { COLLECTION_COLORS } from "../lib/theme";
import type { DirNode, SourceInfo } from "../lib/types";
import { useBrowse, type View } from "../store/browse";
import { dirKey, useLibrary } from "../store/library";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { toast } from "../store/toasts";
import { reviewFolders } from "./AddFolders";
import { openContextMenu } from "./Menu";
import { useConfirm, usePrompt } from "./Prompt";
import { cx, SectionLabel } from "./ui";

function sameView(a: View, b: View): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "collection" && b.type === "collection") return a.id === b.id;
  if (a.type === "folder" && b.type === "folder") return a.sourceId === b.sourceId && a.dir === b.dir;
  return true;
}

function NavItem({
  icon,
  label,
  count,
  countAccent,
  active,
  onClick,
  onContextMenu,
  indent = 0,
  dataAttrs,
  muted,
}: {
  icon?: ReactNode;
  label: string;
  count?: number | null;
  countAccent?: boolean;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  indent?: number;
  dataAttrs?: Record<string, string>;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...dataAttrs}
      className={cx(
        "flex h-[30px] w-full items-center gap-2.5 rounded-md pr-2.5 text-left text-body transition-colors",
        active ? "bg-raised2 text-text" : "text-text2 hover:bg-raised hover:text-text",
        muted && "opacity-60",
      )}
      style={{ paddingLeft: 10 + indent }}
    >
      {icon && <span className="grid w-4 shrink-0 place-items-center text-text3">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && (
        <span className={cx("font-mono text-micro tabular", countAccent ? "text-accent-ink" : "text-text3")}>{fmtCount(count)}</span>
      )}
    </button>
  );
}

/** After folders have left the library: if one is on show (or one inside it), step out to its parent; otherwise refresh the list. */
export function afterExcluded(sourceId: number, dirs: string[]) {
  const browse = useBrowse.getState();
  const v = browse.view;
  const hit = v.type === "folder" && v.sourceId === sourceId ? dirs.find((d) => v.dir === d || v.dir.startsWith(`${d}/`)) : undefined;
  if (hit !== undefined) browse.setView({ type: "folder", sourceId, dir: hit.split("/").slice(0, -1).join("/") });
  else browse.refresh();
}

/** Leaves a subfolder out of the library, after saying what that takes with it. */
function excludeFolder(source: SourceInfo, node: DirNode) {
  useConfirm.getState().ask({
    title: `Exclude “${node.name}”?`,
    body: (
      <>
        Its {fmtCount(node.count)} {node.count === 1 ? "sample leaves" : "samples leave"} your library, along with any favorites, tags and places in collections. The files stay where
        they are, and Saga skips this folder until you include it again.
      </>
    ),
    confirm: "Exclude",
    danger: true,
    onConfirm: async () => {
      if (!(await useLibrary.getState().setExcluded(source.id, node.dir, true))) return;
      afterExcluded(source.id, [node.dir]);
      toast(`“${node.name}” is excluded. Right-click “${source.name}” to include it again.`, "info");
    },
  });
}

async function includeFolder(source: SourceInfo, dir: string) {
  if (!(await useLibrary.getState().setExcluded(source.id, dir, false))) return;
  toast(`Indexing “${dir.split("/").pop()}” again`, "info");
}

function FolderTree({ source, dir, depth }: { source: SourceInfo; dir: string; depth: number }) {
  const nodes = useLibrary((s) => s.dirs[dirKey(source.id, dir)]);
  const expanded = useLibrary((s) => s.expanded);
  const toggle = useLibrary((s) => s.toggleExpanded);
  const view = useBrowse((s) => s.view);
  const setView = useBrowse((s) => s.setView);
  if (!nodes) return null;
  return (
    <div className="flex flex-col gap-px">
      {nodes.map((n) => {
        const key = dirKey(source.id, n.dir);
        const open = !!expanded[key];
        const active = sameView(view, { type: "folder", sourceId: source.id, dir: n.dir });
        return (
          <div key={n.dir}>
            <div className="group relative">
              {n.hasChildren && (
                <button
                  type="button"
                  aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`}
                  onClick={() => toggle(source.id, n.dir)}
                  className="absolute top-[7px] z-10 grid h-4 w-4 place-items-center rounded text-text3 hover:text-text"
                  style={{ left: 6 + depth * 14 }}
                >
                  {open ? <ChevronDown size={12} strokeWidth={2.25} /> : <ChevronRight size={12} strokeWidth={2.25} />}
                </button>
              )}
              <NavItem
                label={n.name}
                count={n.count}
                active={active}
                indent={14 + depth * 14}
                onClick={() => {
                  setView({ type: "folder", sourceId: source.id, dir: n.dir });
                  if (n.hasChildren && !open) toggle(source.id, n.dir);
                }}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: revealLabel(), onSelect: () => void reveal(`${source.path}/${n.dir}`) },
                    "separator",
                    { label: "Exclude from library", danger: true, icon: <FolderMinus size={14} />, onSelect: () => excludeFolder(source, n) },
                  ])
                }
              />
            </div>
            {open && <FolderTree source={source} dir={n.dir} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}

function IndexStatus() {
  const progress = useLibrary((s) => s.progress);
  const stats = useLibrary((s) => s.stats);
  const sources = useLibrary((s) => s.sources);
  const offline = sources.filter((s) => !s.online).length;
  const analyzing = progress.total > 0 && progress.done < progress.total;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line px-5 pt-3 pb-3.5">
      {analyzing ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-small text-text2" title={progress.refreshing ? "Listening to each sample once, for Find similar, the sound map, and tempo and key where names don't say" : undefined}>
              {progress.scanning ? "Scanning and analyzing" : progress.refreshing ? "Listening to your samples" : "Analyzing new files"}
            </span>
            <span className="font-mono text-micro text-text3 tabular">
              {fmtCount(progress.done)} / {fmtCount(progress.total)}
            </span>
          </div>
          <div className="h-[3px] overflow-hidden rounded-full bg-raised2">
            <div className="h-[3px] bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
        </>
      ) : progress.scanning ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="animate-soft-pulse text-small text-text2">Scanning folders…</span>
          <span className="font-mono text-micro text-text3 tabular">{fmtCount(progress.found)}</span>
        </div>
      ) : (
        <span className="text-small text-text2">{fmtCount(stats?.total)} samples</span>
      )}
      <span className="text-micro text-text3">
        {offline > 0
          ? `${offline} ${offline === 1 ? "drive" : "drives"} not connected`
          : progress.watching > 0
            ? `Watching ${progress.watching} ${progress.watching === 1 ? "folder" : "folders"} for changes`
            : "Not watching any folders"}
      </span>
    </div>
  );
}

export async function chooseFolders() {
  const picked = await open({ directory: true, multiple: true, title: "Add sample folders" });
  const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
  await reviewFolders(paths);
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const clampSidebar = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));

/** The sidebar's right edge: drag to resize, arrow keys to nudge, double-click to go back to the default width. */
function ResizeHandle({ width }: { width: number }) {
  const set = usePrefs((s) => s.set);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = width;
    const move = (ev: PointerEvent) => set({ sidebarWidth: clampSidebar(start + ev.clientX - startX) });
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const current = usePrefs.getState().sidebarWidth;
    if (e.key === "ArrowLeft") set({ sidebarWidth: clampSidebar(current - step) });
    else if (e.key === "ArrowRight") set({ sidebarWidth: clampSidebar(current + step) });
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => set({ sidebarWidth: DEFAULT_PREFS.sidebarWidth })}
      className="group absolute inset-y-0 -right-[3px] z-20 w-[6px] cursor-col-resize touch-none outline-none"
    >
      <span className="absolute inset-y-0 left-[2px] w-px bg-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  );
}

export function Sidebar() {
  const width = clampSidebar(usePrefs((s) => s.sidebarWidth));
  const stats = useLibrary((s) => s.stats);
  const collections = useLibrary((s) => s.collections);
  const sources = useLibrary((s) => s.sources);
  const expanded = useLibrary((s) => s.expanded);
  const toggle = useLibrary((s) => s.toggleExpanded);
  const view = useBrowse((s) => s.view);
  const setView = useBrowse((s) => s.setView);

  const go = (v: View) => setView(v);

  const collectionMenu = (e: React.MouseEvent, id: number, name: string) =>
    openContextMenu(e, [
      {
        label: "Rename…",
        onSelect: () =>
          usePrompt.getState().ask({
            title: "Rename collection",
            initial: name,
            confirm: "Rename",
            onSubmit: async (n) => {
              await api.updateCollection(id, { name: n });
              await useLibrary.getState().refreshCollections();
            },
          }),
      },
      {
        label: "Color",
        submenu: COLLECTION_COLORS.map((c) => ({
          label: c.name,
          icon: <span className="block h-2.5 w-2.5 rounded-full" style={{ background: c.hex }} />,
          onSelect: async () => {
            await api.updateCollection(id, { color: c.hex });
            await useLibrary.getState().refreshCollections();
          },
        })),
      },
      "separator",
      {
        label: "Delete collection",
        danger: true,
        icon: <Trash2 size={14} />,
        onSelect: async () => {
          try {
            await api.deleteCollection(id);
            await useLibrary.getState().refreshCollections();
            if (view.type === "collection" && view.id === id) go({ type: "all" });
          } catch (err) {
            toast(errorMessage(err));
          }
        },
      },
    ]);

  const sourceMenu = (e: React.MouseEvent, s: SourceInfo) =>
    openContextMenu(e, [
      { label: "Rescan", icon: <RefreshCw size={14} />, onSelect: () => void useLibrary.getState().rescan(s.id) },
      { label: revealLabel(), onSelect: () => void reveal(s.path) },
      ...(s.excluded.length
        ? [{ label: "Include excluded folder", icon: <FolderPlus size={14} />, submenu: s.excluded.map((dir) => ({ label: dir, onSelect: () => void includeFolder(s, dir) })) }]
        : []),
      "separator",
      {
        label: "Remove from library",
        danger: true,
        icon: <Trash2 size={14} />,
        onSelect: async () => {
          await useLibrary.getState().removeSource(s.id);
          if (view.type === "folder" && view.sourceId === s.id) go({ type: "all" });
          useBrowse.getState().refresh();
        },
      },
    ]);

  return (
    <nav aria-label="Library" style={{ width }} className="relative flex shrink-0 flex-col border-r border-line bg-panel">
      <ResizeHandle width={width} />
      <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-2.5 py-3.5">
        <div className="flex flex-col gap-px">
          <SectionLabel className="px-2.5 pb-1.5">Library</SectionLabel>
          <NavItem icon={<AudioLines size={16} strokeWidth={1.75} />} label="All samples" count={stats?.total} active={view.type === "all"} onClick={() => go({ type: "all" })} />
          <NavItem icon={<Star size={16} strokeWidth={1.75} />} label="Favorites" count={stats?.favorites} active={view.type === "favorites"} onClick={() => go({ type: "favorites" })} />
          <NavItem icon={<Clock size={16} strokeWidth={1.75} />} label="Recently played" active={view.type === "recent-played"} onClick={() => go({ type: "recent-played" })} />
          <NavItem
            icon={<Sparkle size={16} strokeWidth={1.75} />}
            label="Recently added"
            count={stats?.recentlyAdded || null}
            countAccent
            active={view.type === "recent-added"}
            onClick={() => go({ type: "recent-added" })}
          />
        </div>

        <div className="flex flex-col gap-px">
          <SectionLabel className="px-2.5 pb-1.5">Collections</SectionLabel>
          {collections.map((c) => (
            <NavItem
              key={c.id}
              dataAttrs={{ "data-collection-id": String(c.id) }}
              icon={<span className="block h-2 w-2 rounded-full" style={{ background: c.color }} />}
              label={c.name}
              count={c.count}
              active={view.type === "collection" && view.id === c.id}
              onClick={() => go({ type: "collection", id: c.id })}
              onContextMenu={(e) => collectionMenu(e, c.id, c.name)}
            />
          ))}
          <button type="button" onClick={() => newCollection()} className="flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-body text-text3 hover:bg-raised hover:text-text">
            <Plus size={16} strokeWidth={1.75} />
            <span>New collection</span>
          </button>
        </div>

        <div className="flex flex-col gap-px">
          <SectionLabel className="px-2.5 pb-1.5">Folders</SectionLabel>
          {sources.map((s) => {
            const key = dirKey(s.id, "");
            const open = !!expanded[key];
            return (
              <div key={s.id}>
                <div className="relative">
                  <button
                    type="button"
                    aria-label={open ? `Collapse ${s.name}` : `Expand ${s.name}`}
                    onClick={() => toggle(s.id, "")}
                    className="absolute top-[7px] left-1 z-10 grid h-4 w-4 place-items-center rounded text-text3 hover:text-text"
                  >
                    {open ? <ChevronDown size={12} strokeWidth={2.25} /> : <ChevronRight size={12} strokeWidth={2.25} />}
                  </button>
                  <NavItem
                    icon={s.online ? <Folder size={16} strokeWidth={1.75} /> : <HardDrive size={16} strokeWidth={1.75} />}
                    label={s.name}
                    count={s.count}
                    indent={12}
                    muted={!s.online}
                    active={sameView(view, { type: "folder", sourceId: s.id, dir: "" })}
                    onClick={() => {
                      go({ type: "folder", sourceId: s.id, dir: "" });
                      if (!open) toggle(s.id, "");
                    }}
                    onContextMenu={(e) => sourceMenu(e, s)}
                  />
                </div>
                {open && <FolderTree source={s} dir="" depth={1} />}
              </div>
            );
          })}
          <button type="button" onClick={() => void chooseFolders()} className="flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-body text-text3 hover:bg-raised hover:text-text">
            <Plus size={16} strokeWidth={1.75} />
            <span>Add folder</span>
          </button>
        </div>
      </div>
      <IndexStatus />
    </nav>
  );
}
