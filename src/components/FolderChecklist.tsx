import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../lib/api";
import type { Subfolder } from "../lib/types";
import { cx } from "./ui";

export interface ChecklistRoot {
  name: string;
  path: string;
  subfolders: Subfolder[];
}

/** A folder in the checklist: the root's index, then its path inside that root ("" for the root itself). */
export const keyOf = (index: number, rel: string) => `${index}|${rel}`;

/** The unticked folders under root `index`, relative to it. */
export function offIn(off: Set<string>, index: number): string[] {
  const prefix = keyOf(index, "");
  return [...off].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/**
 * Folders to tick or untick, each opening to the folders inside it. Unticked folders are `off`;
 * one covers everything inside it. A root can be left unticked too, unless `rootsCheckable` is off.
 */
export function FolderChecklist({
  roots,
  off,
  setOff,
  rootsCheckable = true,
}: {
  roots: ChecklistRoot[];
  off: Set<string>;
  setOff: Dispatch<SetStateAction<Set<string>>>;
  rootsCheckable?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set(roots.map((_, i) => keyOf(i, "")));
    // Folders that start unticked are shown, with the ones above them open.
    for (const [index, rel] of [...off].map(splitKey)) {
      const segs = rel.split("/");
      for (let n = 1; n < segs.length; n++) open.add(keyOf(index, segs.slice(0, n).join("/")));
    }
    return open;
  });
  const [children, setChildren] = useState<Record<string, Subfolder[]>>(() => Object.fromEntries(roots.map((c, i) => [keyOf(i, ""), c.subfolders])));

  const load = (index: number, rel: string) => {
    const key = keyOf(index, rel);
    api
      .listSubfolders(`${roots[index].path}/${rel}`)
      .then((list) => setChildren((c) => ({ ...c, [key]: list })))
      .catch(() => setChildren((c) => ({ ...c, [key]: [] })));
  };

  useEffect(() => {
    for (const key of expanded) {
      if (children[key]) continue;
      const [index, rel] = splitKey(key);
      load(index, rel);
    }
    // Once: opens the folders that started unticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const offByParent = (index: number, rel: string) => {
    if (rel === "") return false;
    if (off.has(keyOf(index, ""))) return true;
    const segs = rel.split("/");
    return segs.slice(0, -1).some((_, i) => off.has(keyOf(index, segs.slice(0, i + 1).join("/"))));
  };
  const inside = (index: number, rel: string) => keyOf(index, rel === "" ? "" : `${rel}/`);

  const toggle = (index: number, rel: string) => {
    const key = keyOf(index, rel);
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        for (const k of next) if (k.startsWith(inside(index, rel))) next.delete(k);
        next.add(key);
      }
      return next;
    });
  };

  const expand = (index: number, rel: string) => {
    const key = keyOf(index, rel);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!children[key]) load(index, rel);
  };

  const row = (index: number, rel: string, name: string, hasChildren: boolean, depth: number) => {
    const key = keyOf(index, rel);
    const disabled = offByParent(index, rel);
    const checked = !disabled && !off.has(key);
    const partial = checked && [...off].some((k) => k !== key && k.startsWith(inside(index, rel)));
    const open = expanded.has(key);
    const root = rel === "";
    return (
      <div key={key}>
        <div className="flex h-8 items-center gap-2 rounded-md pr-2 hover:bg-raised" style={{ paddingLeft: 6 + depth * 18 }}>
          {hasChildren ? (
            <button type="button" aria-label={open ? `Collapse ${name}` : `Expand ${name}`} onClick={() => expand(index, rel)} className="grid h-5 w-5 shrink-0 place-items-center rounded text-text3 hover:text-text">
              {open ? <ChevronDown size={12} strokeWidth={2.25} /> : <ChevronRight size={12} strokeWidth={2.25} />}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <label className={cx("flex min-w-0 flex-1 items-center gap-2.5", disabled && "opacity-45")}>
            {(!root || rootsCheckable) && (
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                ref={(el) => {
                  if (el) el.indeterminate = partial;
                }}
                onChange={() => toggle(index, rel)}
                className="h-[15px] w-[15px] shrink-0"
                style={{ accentColor: "var(--accent)" }}
              />
            )}
            <span className={cx("shrink-0 truncate text-ui", root ? "max-w-[45%] font-semibold" : "max-w-full")}>{name}</span>
            {root && <span className="min-w-0 flex-1 truncate font-mono text-micro text-text3">{roots[index].path}</span>}
          </label>
        </div>
        {open && children[key]?.map((c) => row(index, rel === "" ? c.name : `${rel}/${c.name}`, c.name, c.hasChildren, depth + 1))}
      </div>
    );
  };

  return <>{roots.map((c, i) => row(i, "", c.name, c.subfolders.length > 0, 0))}</>;
}

function splitKey(key: string): [number, string] {
  const at = key.indexOf("|");
  return [Number(key.slice(0, at)), key.slice(at + 1)];
}
