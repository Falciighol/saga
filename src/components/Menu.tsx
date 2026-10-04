import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { cx } from "./ui";

export type MenuItem =
  | "separator"
  | {
      label: string;
      icon?: ReactNode;
      hint?: string;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
    };

interface MenuState {
  menu: { id: number; x: number; y: number; items: MenuItem[]; minWidth?: number } | null;
  open: (x: number, y: number, items: MenuItem[], minWidth?: number) => void;
  close: () => void;
}

let opened = 0;

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items, minWidth) => set({ menu: { id: ++opened, x, y, items, minWidth } }),
  close: () => set({ menu: null }),
}));

/** Opens a menu at the pointer (for right-click). */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) {
  e.preventDefault();
  useMenu.getState().open(e.clientX, e.clientY, items);
}

/** Opens a menu under a button (for dropdowns). */
export function openMenuBelow(el: HTMLElement, items: MenuItem[], align: "left" | "right" = "left") {
  const r = el.getBoundingClientRect();
  useMenu.getState().open(align === "left" ? r.left : r.right, r.bottom + 4, items, align === "right" ? -1 : r.width);
}

/** How far menus keep from the window's edges. */
const EDGE = 8;
/** The space between a menu and its submenu. */
const GAP = 4;

type Side = "left" | "right";
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a menu goes: at a point, growing toward `side` from it, or beside its parent menu, on `side` if there's
 * room there and on the other side if not.
 */
type Place = { x: number; y: number; side: Side } | { parent: Box; y: number; side: Side };

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function MenuList({
  items,
  place,
  ancestors,
  minWidth,
  back,
  onNoRoom,
  onDone,
}: {
  items: MenuItem[];
  place: Place;
  /** The menus showing behind this one, which it mustn't cover. */
  ancestors: Box[];
  minWidth?: number;
  /** A row that goes back to the parent menu, for a submenu showing in its parent's place. */
  back?: { label: string; onBack: () => void };
  /** Called instead of showing when there's no room on either side of the parent. */
  onNoRoom?: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ rect: Box; side: Side } | null>(null);
  const [sub, setSub] = useState<{ index: number; y: number; clicked: boolean; inPlace: boolean } | null>(null);

  // Measures the menu, hidden at the window's corner, and places it. This runs once: a menu that needs a new place
  // is mounted again (see the keys below).
  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const top = Math.max(EDGE, Math.min(place.y, window.innerHeight - EDGE - h));
    const at = (left: number, side: Side) => ({ rect: { left, top, right: left + w, bottom: top + h }, side });
    if (!("parent" in place)) {
      const left = place.side === "right" ? place.x : place.x - w;
      setBox(at(Math.max(EDGE, Math.min(left, vw - EDGE - w)), place.side));
      return;
    }
    const { parent } = place;
    const sides: Side[] = place.side === "right" ? ["right", "left"] : ["left", "right"];
    const options = sides
      .map((side) => at(side === "right" ? parent.right + GAP : parent.left - GAP - w, side))
      .filter(({ rect }) => rect.left >= EDGE && rect.right <= vw - EDGE && ancestors.every((a) => !overlaps(a, rect)));
    // A menu with submenus of its own takes the side that leaves room for them too.
    const nested = items.some((item) => item !== "separator" && item.submenu);
    const roomBeyond = ({ rect, side }: { rect: Box; side: Side }) =>
      side === "right" ? rect.right + GAP + w <= vw - EDGE : rect.left - GAP - w >= EDGE;
    const pick = (nested && options.find(roomBeyond)) || options[0];
    if (pick) setBox(pick);
    else onNoRoom?.();
  }, []);

  const subItem = sub ? items[sub.index] : undefined;
  const submenu = subItem && subItem !== "separator" && subItem.submenu ? { label: subItem.label, items: subItem.submenu } : null;

  // No room beside this menu: the submenu shows in its place instead, keeping the edge that faces the menus behind.
  if (sub?.inPlace && submenu && box) {
    return (
      <MenuList
        items={submenu.items}
        place={{ x: box.side === "right" ? box.rect.left : box.rect.right, y: box.rect.top, side: box.side }}
        ancestors={ancestors}
        minWidth={box.rect.right - box.rect.left}
        back={{ label: submenu.label, onBack: () => setSub(null) }}
        onDone={onDone}
      />
    );
  }

  const openSub = (index: number, row: HTMLElement, clicked: boolean) => {
    const y = row.getBoundingClientRect().top - 4;
    setSub((s) => (s?.index === index ? s : { index, y, clicked, inPlace: false }));
  };

  return (
    <>
      <div
        ref={ref}
        role="menu"
        className="animate-pop fixed z-[70] max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-line2 bg-panel p-1 shadow-pop"
        style={{
          ...(box ? { left: box.rect.left, top: box.rect.top } : { left: 0, top: 0, visibility: "hidden" }),
          minWidth: Math.max(180, minWidth && minWidth > 0 ? minWidth : 0),
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {back && (
          <>
            <button
              type="button"
              role="menuitem"
              onMouseEnter={() => setSub(null)}
              onClick={back.onBack}
              className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui font-medium whitespace-nowrap text-text2 hover:bg-raised hover:text-text"
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <ChevronLeft size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate">{back.label}</span>
            </button>
            <div className="mx-2 my-1 h-px bg-line" />
          </>
        )}
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="mx-2 my-1 h-px bg-line" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={(e) => {
                if (item.submenu) openSub(i, e.currentTarget, false);
                else setSub(null);
              }}
              onClick={(e) => {
                if (item.submenu) {
                  openSub(i, e.currentTarget, true);
                  return;
                }
                item.onSelect?.();
                onDone();
              }}
              className={cx(
                "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui whitespace-nowrap disabled:opacity-40",
                item.danger ? "text-[#E5705E] hover:bg-raised" : "text-text hover:bg-raised",
                sub?.index === i && "bg-raised",
              )}
            >
              <span className="grid w-4 shrink-0 place-items-center text-text3">
                {item.checked ? <Check size={14} className="text-accent-ink" /> : item.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 font-mono text-micro text-text3">{item.hint}</span>}
              {item.submenu && <ChevronRight size={14} className="shrink-0 text-text3" />}
            </button>
          ),
        )}
      </div>
      {sub && submenu && box && (
        <MenuList
          key={sub.index}
          items={submenu.items}
          place={{ parent: box.rect, y: sub.y, side: box.side }}
          ancestors={[...ancestors, box.rect]}
          // Opened by hovering, the submenu waits for a click before taking this menu's place.
          onNoRoom={() => setSub((s) => s && (s.clicked ? { ...s, inPlace: true } : null))}
          onDone={onDone}
        />
      )}
    </>
  );
}

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const close = useMenu((s) => s.close);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onBlur = () => close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <MenuList
        key={menu.id}
        items={menu.items}
        place={{ x: menu.x, y: menu.y, side: menu.minWidth === -1 ? "left" : "right" }}
        ancestors={[]}
        minWidth={menu.minWidth}
        onDone={close}
      />
    </>
  );
}
