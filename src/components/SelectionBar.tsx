import { ChevronDown, FolderPlus, PenLine, Star, X } from "lucide-react";
import { collectionSubmenu, dragSamples, keySubmenu, renameTargets, tempoSubmenu } from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import { modKey } from "../lib/platform";
import { targetIds, targetRows, useBrowse } from "../store/browse";
import { useLibrary } from "../store/library";
import { toast } from "../store/toasts";
import { openMenuBelow, type MenuItem } from "./Menu";
import { GripIcon } from "./PreviewPanel";
import { Divider, IconButton } from "./ui";

const BUTTON = "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-ui text-text2 hover:bg-raised hover:text-text";

/** Shown while several samples are picked: what can be done to all of them at once. */
export function SelectionBar() {
  const count = useBrowse((s) => s.picked.size);
  if (count < 2) return null;

  const menu = (items: () => MenuItem[]) => (e: React.MouseEvent<HTMLButtonElement>) => openMenuBelow(e.currentTarget, items());
  const ids = () => targetIds();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-4">
      <div role="toolbar" aria-label={`${count} samples selected`} className="animate-pop pointer-events-auto flex items-center gap-1 rounded-xl border border-line2 bg-panel p-1 pl-3.5 shadow-pop">
        <span className="pr-1.5 text-ui font-semibold whitespace-nowrap tabular" title={`${modKey}-click or Shift-click rows to change the selection`}>
          {count.toLocaleString("en-US")} selected
        </span>
        <Divider />
        <button type="button" onClick={menu(() => keySubmenu(ids()))} className={BUTTON}>
          Key <ChevronDown size={13} />
        </button>
        <button type="button" onClick={menu(() => tempoSubmenu(ids()))} className={BUTTON}>
          Tempo <ChevronDown size={13} />
        </button>
        <button type="button" onClick={() => void renameTargets()} className={BUTTON}>
          <PenLine size={14} /> Rename…
        </button>
        <Divider />
        <IconButton
          label="Add to favorites"
          onClick={async () => {
            try {
              await api.setFavorite(ids(), true);
              void useLibrary.getState().refreshStats();
              useBrowse.getState().refresh();
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        >
          <Star size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Add to collection" onClick={menu(() => collectionSubmenu(ids()))}>
          <FolderPlus size={15} strokeWidth={1.75} />
        </IconButton>
        <div
          draggable
          role="button"
          tabIndex={-1}
          aria-label={`Drag ${count} samples into your DAW`}
          title="Drag into your DAW: each as you hear it"
          onDragStart={(e) => {
            e.preventDefault();
            void targetRows().then(dragSamples);
          }}
          className="ml-1 flex h-8 shrink-0 cursor-grab items-center gap-2 rounded-lg border border-line2 bg-raised pr-3 pl-2 text-ui font-semibold active:cursor-grabbing"
        >
          <GripIcon className="fill-text3" />
          Drag {count.toLocaleString("en-US")}
        </div>
        <IconButton label="Clear selection (Esc)" onClick={() => useBrowse.getState().clearPicked()}>
          <X size={15} />
        </IconButton>
      </div>
    </div>
  );
}
