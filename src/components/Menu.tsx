import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";
import { isTextInput } from "../lib/platform";
import { cx } from "./ui";

export type MenuItem =
  | "separator"
  | {
      label: string;
      icon?: ReactNode;
      hint?: string;
      checked?: boolean;
      /** The ticked item is one choice among its neighbours (a sort order), not something switched on and off. */
      radio?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
      /** Choosing it leaves the menu open and redraws it, for ticking several in a row. Needs a menu opened with a
       *  function that builds its items. */
      keepOpen?: boolean;
      /** A small title over the items after it, not something to choose. */
      heading?: boolean;
      /** Drawn quieter: there, but set aside (a hidden app). */
      muted?: boolean;
      /** The row folds the rows after it in and out, like a section's heading. */
      expanded?: boolean;
      /** A second action on the same thing (hiding it, say), as a small button at the row's end that shows when the
       *  row is pointed at or focused; → reaches it from the keyboard. It leaves the menu open and redraws it, so the
       *  menu needs a function that builds its items. */
      aside?: { label: string; icon: ReactNode; onSelect: () => void };
    };

/** A menu's items, or a function that builds them, so a menu that stays open can show what changed. */
export type MenuItems = MenuItem[] | (() => MenuItem[]);

interface MenuState {
  menu: {
    id: number;
    x: number;
    y: number;
    items: MenuItem[];
    build: (() => MenuItem[]) | null;
    minWidth?: number;
    /** Where focus goes back to when the menu closes. Only set for a menu opened from the keyboard. */
    restore: HTMLElement | null;
  } | null;
  /** `keyboard` puts focus on the first item, and back on what had it when the menu closes. */
  open: (x: number, y: number, items: MenuItems, minWidth?: number, keyboard?: boolean) => void;
  /** Builds the open menu's items again, after an item that keeps it open. */
  refresh: () => void;
  close: () => void;
}

let opened = 0;

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items, minWidth, keyboard = false) =>
    set({
      menu: {
        id: ++opened,
        x,
        y,
        items: typeof items === "function" ? items() : items,
        build: typeof items === "function" ? items : null,
        minWidth,
        restore: keyboard && document.activeElement instanceof HTMLElement ? document.activeElement : null,
      },
    }),
  refresh: () => set((s) => (s.menu?.build ? { menu: { ...s.menu, items: s.menu.build() } } : s)),
  close: () => set({ menu: null }),
}));

/** Opens a menu at the pointer (for right-click). */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItems) {
  e.preventDefault();
  useMenu.getState().open(e.clientX, e.clientY, items);
}

/** Opens a menu under a button (for dropdowns). A button pressed from the keyboard hands focus to the menu. */
export function openMenuBelow(el: HTMLElement, items: MenuItems, align: "left" | "right" = "left") {
  const r = el.getBoundingClientRect();
  useMenu.getState().open(align === "left" ? r.left : r.right, r.bottom + 4, items, align === "right" ? -1 : r.width, el.matches(":focus-visible"));
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
  autoFocus,
  onLeave,
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
  /** Puts focus on the first item once the menu is placed, for a menu opened from the keyboard. */
  autoFocus?: boolean;
  /** ← in a submenu: closes it and goes back to its row in the parent. */
  onLeave?: () => void;
  /** Called instead of showing when there's no room on either side of the parent. */
  onNoRoom?: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ rect: Box; side: Side } | null>(null);
  const [sub, setSub] = useState<{ index: number; y: number; clicked: boolean; inPlace: boolean; keyboard: boolean } | null>(null);
  // The row to focus once a submenu closes, so ← lands back where → left, or once an aside action moved its row away
  // (a hidden app): the row that came after it, found by its label since rows shift.
  const refocus = useRef<{ index: number; label?: string } | null>(null);

  // Measures the menu at the window's corner, where nothing squeezes it, and places it. It runs again when the items
  // change, since a menu that stays open can grow (a list that finishes loading after the menu opened) and must still
  // fit the window. A menu that needs a new place for any other reason is mounted again (see the keys below).
  useLayoutEffect(() => {
    const el = ref.current!;
    const { left: wasLeft, top: wasTop } = el.style;
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Put it back as React left it, so React's own update moves it, and focus and scrolling inside stay put.
    el.style.left = wasLeft;
    el.style.top = wasTop;
    const vw = window.innerWidth;
    // Placed again, it keeps its top unless it grew past the window's bottom: a row taken out lets the rows under it
    // move up beneath the pointer, the way a list does, rather than the rows above sliding down.
    const top = Math.max(EDGE, Math.min(box ? box.rect.top : place.y, window.innerHeight - EDGE - h));
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
  }, [items]);

  useEffect(() => {
    if (box && autoFocus) rows()[0]?.focus();
    // Only once, when the menu first has its place.
  }, [box != null]);

  useEffect(() => {
    if (sub || refocus.current == null) return;
    const { index, label } = refocus.current;
    refocus.current = null;
    const list = rows();
    const labelOf = (row: HTMLElement) => {
      const item = items[Number(row.dataset.index)];
      return item && item !== "separator" ? item.label : undefined;
    };
    const named = label != null ? list.find((row) => labelOf(row) === label) : undefined;
    (named ?? list.find((row) => Number(row.dataset.index) >= index) ?? list.at(-1))?.focus();
  });

  const rows = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-row]:not(:disabled)") ?? [])];

  const closeSub = () => {
    if (sub) refocus.current = { index: sub.index };
    setSub(null);
  };

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
        back={{ label: submenu.label, onBack: closeSub }}
        autoFocus={sub.keyboard}
        onDone={onDone}
      />
    );
  }

  const openSub = (index: number, row: HTMLElement, clicked: boolean, keyboard = false) => {
    const y = row.getBoundingClientRect().top - 4;
    setSub((s) => (s?.index === index && !keyboard ? s : { index, y, clicked, inPlace: false, keyboard }));
  };

  // Arrow keys walk the rows the way native menus do. Enter and Space press the focused row, Esc (in MenuHost)
  // closes every menu, and Tab leaves the menu.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const list = rows();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // On a row's aside button, the keys go on from its row.
    const onAside = active?.dataset.aside != null;
    const current = onAside ? active!.parentElement?.querySelector<HTMLButtonElement>("[data-row]") : active;
    const at = list.indexOf(current as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    const row = at >= 0 ? list[at] : null;
    const index = row?.dataset.index != null ? Number(row.dataset.index) : -1;
    const item = index >= 0 ? items[index] : undefined;
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "ArrowRight" && row && item && item !== "separator" && item.submenu) openSub(index, row, true, true);
    else if (e.key === "ArrowRight" && row && !onAside && item && item !== "separator" && item.aside) {
      row.parentElement?.querySelector<HTMLElement>("[data-aside]")?.focus();
    } else if (e.key === "ArrowLeft" && onAside && row) row.focus();
    else if (e.key === "ArrowLeft" && (back || onLeave)) (back ? back.onBack : onLeave!)();
    else if (e.key === "Tab") onDone();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <div
        ref={ref}
        role="menu"
        className="animate-pop fixed z-[70] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-line2 bg-panel p-1 shadow-pop"
        style={{
          ...(box ? { left: box.rect.left, top: box.rect.top } : { left: 0, top: 0, visibility: "hidden" }),
          minWidth: Math.max(180, minWidth && minWidth > 0 ? minWidth : 0),
          // The same window height the placement measures against, so a long menu always fits and scrolls inside.
          maxHeight: window.innerHeight - 2 * EDGE,
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
      >
        {back && (
          <>
            <button
              type="button"
              role="menuitem"
              data-row=""
              onMouseEnter={(e) => {
                setSub(null);
                followPointer(e.currentTarget);
              }}
              onClick={back.onBack}
              className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui font-medium whitespace-nowrap text-text2 hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text"
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <ChevronLeft size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate">{back.label}</span>
            </button>
            <div className="mx-2 my-1 h-px bg-line" />
          </>
        )}
        {items.map((item, i) => {
          if (item === "separator") return <div key={i} className="mx-2 my-1 h-px bg-line" />;
          if (item.heading) {
            return (
              <div key={i} role="presentation" className="px-2.5 pt-2 pb-1 text-micro font-medium text-text3 first:pt-1">
                {item.label}
              </div>
            );
          }
          const row = (
            <button
              key={i}
              type="button"
              role={item.checked == null ? "menuitem" : item.radio ? "menuitemradio" : "menuitemcheckbox"}
              aria-checked={item.checked != null ? item.checked : undefined}
              aria-haspopup={item.submenu ? "menu" : undefined}
              aria-expanded={item.submenu ? sub?.index === i : item.expanded}
              data-row=""
              data-index={i}
              disabled={item.disabled}
              onMouseEnter={(e) => {
                if (item.submenu) openSub(i, e.currentTarget, false);
                else setSub(null);
                followPointer(e.currentTarget);
              }}
              onClick={(e) => {
                if (item.submenu) {
                  openSub(i, e.currentTarget, true);
                  return;
                }
                item.onSelect?.();
                if (item.keepOpen) useMenu.getState().refresh();
                else onDone();
              }}
              className={cx(
                "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui whitespace-nowrap hover:bg-raised focus-visible:bg-raised disabled:opacity-40",
                item.danger ? "text-[#E5705E]" : item.muted ? "text-text2" : "text-text",
                sub?.index === i && "bg-raised",
              )}
            >
              <span className={cx("grid w-4 shrink-0 place-items-center text-text3", item.muted && !item.checked && "opacity-55")}>
                {item.checked ? <Check size={14} className="text-accent-ink" /> : item.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {/* The aside button shows over the end of the row, where the hint steps aside for it. */}
              {(item.hint || item.aside) && (
                <span
                  className={cx(
                    "shrink-0 text-right font-mono text-micro text-text3",
                    item.aside && "min-w-5 group-focus-within/row:invisible group-hover/row:invisible",
                  )}
                >
                  {item.hint}
                </span>
              )}
              {item.submenu && <ChevronRight size={14} className="shrink-0 text-text3" />}
            </button>
          );
          if (!item.aside) return row;
          const aside = item.aside;
          return (
            <div key={i} role="none" className="group/row relative">
              {row}
              <button
                type="button"
                role="menuitem"
                data-aside=""
                aria-label={aside.label}
                title={aside.label}
                // A click doesn't take focus, so the keyboard's place in the menu stays where it was.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSub(null)}
                onClick={(e) => {
                  if (document.activeElement === e.currentTarget) {
                    const list = rows();
                    const at = list.findIndex((row) => row.dataset.index === String(i));
                    const after = list[at + 1] ?? list[at - 1];
                    const next = after ? items[Number(after.dataset.index)] : undefined;
                    refocus.current = { index: i, label: next && next !== "separator" ? next.label : undefined };
                  }
                  aside.onSelect();
                  useMenu.getState().refresh();
                }}
                className={cx(
                  "absolute top-1 right-1.5 grid h-6 w-6 place-items-center rounded-md text-text3 opacity-0 outline-none",
                  "group-focus-within/row:opacity-100 group-hover/row:opacity-100",
                  "hover:bg-raised2 hover:text-text focus-visible:bg-raised2 focus-visible:text-text",
                )}
              >
                {aside.icon}
              </button>
            </div>
          );
        })}
      </div>
      {sub && submenu && box && (
        <MenuList
          key={sub.index}
          items={submenu.items}
          place={{ parent: box.rect, y: sub.y, side: box.side }}
          ancestors={[...ancestors, box.rect]}
          autoFocus={sub.keyboard}
          onLeave={closeSub}
          // Opened by hovering, the submenu waits for a click before taking this menu's place.
          onNoRoom={() => setSub((s) => s && (s.clicked ? { ...s, inPlace: true } : null))}
          onDone={onDone}
        />
      )}
    </>
  );
}

/** Once the keyboard is in a menu, the row under the pointer takes focus, so only one row ever looks current. */
function followPointer(row: HTMLElement) {
  if (document.activeElement?.closest('[role="menu"]')) row.focus({ preventScroll: true });
}

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const close = useMenu((s) => s.close);
  // Where focus goes back to when the menu closes: what had it when a menu was opened from the keyboard, or when the
  // keyboard took over a menu opened with the mouse.
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !document.activeElement?.closest('[role="menu"]')) {
        // A menu opened with the mouse takes the keyboard on the first arrow press.
        e.stopPropagation();
        e.preventDefault();
        // Only a control the keyboard had reached, or a text field, gets focus back. A button you clicked doesn't, so
        // Space after the menu still plays (see useHotkeys).
        const had = document.activeElement;
        if (!restore.current && had instanceof HTMLElement && (had.matches(":focus-visible") || isTextInput(had))) restore.current = had;
        const menus = document.querySelectorAll<HTMLElement>('[role="menu"]');
        const list = menus[menus.length - 1]?.querySelectorAll<HTMLButtonElement>("[data-row]:not(:disabled)");
        list?.[e.key === "ArrowDown" ? 0 : list.length - 1]?.focus();
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

  // Focus goes back when the menu closes, unless what was chosen moved it elsewhere (a dialog that focuses its own
  // field, say).
  useEffect(() => {
    if (!menu) return;
    restore.current = menu.restore;
    return () => {
      const back = restore.current;
      restore.current = null;
      const now = document.activeElement;
      if (back?.isConnected && (now == null || now === document.body)) back.focus();
    };
    // A menu that redraws after an item that keeps it open is still the same menu.
  }, [menu?.id]);

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
        autoFocus={menu.restore != null}
        onDone={close}
      />
    </>
  );
}
