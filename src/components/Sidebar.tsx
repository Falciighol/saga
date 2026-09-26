import { open } from "@tauri-apps/plugin-dialog";
import { AudioLines, ChevronDown, ChevronRight, Clock, Folder, HardDrive, Plus, RefreshCw, Sparkle, Star, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { newCollection, reveal } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { fmtCount } from "../lib/format";
import { revealLabel } from "../lib/platform";
import { COLLECTION_COLORS } from "../lib/theme";
import type { SourceInfo } from "../lib/types";
import { useBrowse, type View } from "../store/browse";
import { dirKey, useLibrary } from "../store/library";
import { toast } from "../store/toasts";
import { openContextMenu } from "./Menu";
import { usePrompt } from "./Prompt";
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
                  openContextMenu(e, [{ label: revealLabel(), onSelect: () => void reveal(`${source.path}/${n.dir}`) }])
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
  if (paths.length) await useLibrary.getState().addFolders(paths);
}

export function Sidebar() {
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
    <nav aria-label="Library" className="flex w-[232px] shrink-0 flex-col border-r border-line bg-panel">
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
