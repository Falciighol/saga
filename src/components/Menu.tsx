import { Check, ChevronRight } from "lucide-react";
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
  menu: { x: number; y: number; items: MenuItem[]; minWidth?: number } | null;
  open: (x: number, y: number, items: MenuItem[], minWidth?: number) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, items, minWidth) => set({ menu: { x, y, items, minWidth } }),
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

function MenuList({ items, x, y, minWidth, onDone }: { items: MenuItem[]; x: number; y: number; minWidth?: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = minWidth === -1 ? x - r.width : x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 8) nx = window.innerWidth - r.width - 8;
    if (ny + r.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(8, nx), y: ny });
  }, [x, y, minWidth]);

  return (
    <>
      <div
        ref={ref}
        role="menu"
        className="animate-pop fixed z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-line2 bg-panel p-1 shadow-pop"
        style={{ left: pos.x, top: pos.y, minWidth: Math.max(180, minWidth && minWidth > 0 ? minWidth : 0) }}
        onContextMenu={(e) => e.preventDefault()}
      >
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
                if (item.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ index: i, x: r.right + 2, y: r.top - 4 });
                } else setSub(null);
              }}
              onClick={(e) => {
                if (item.submenu) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ index: i, x: r.right + 2, y: r.top - 4 });
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
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="font-mono text-micro text-text3">{item.hint}</span>}
              {item.submenu && <ChevronRight size={14} className="text-text3" />}
            </button>
          ),
        )}
      </div>
      {sub && typeof items[sub.index] === "object" && (items[sub.index] as { submenu?: MenuItem[] }).submenu && (
        <MenuList items={(items[sub.index] as { submenu: MenuItem[] }).submenu} x={sub.x} y={sub.y} onDone={onDone} />
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
        className="fixed inset-0 z-40"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <MenuList items={menu.items} x={menu.x} y={menu.y} minWidth={menu.minWidth} onDone={close} />
    </>
  );
}
