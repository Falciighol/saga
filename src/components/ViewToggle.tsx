import { List } from "lucide-react";
import { useUi } from "../store/ui";
import { cx } from "./ui";

export function MapIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="6" cy="7" r="2" />
      <circle cx="17" cy="6" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
      <circle cx="18" cy="16" r="1.5" />
    </svg>
  );
}

export function SimilarIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
    </svg>
  );
}

/** Switches the browser between the list and the sound map. */
export function ViewToggle() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const option = (value: "list" | "map", label: string, icon: React.ReactNode) => (
    <button
      type="button"
      aria-pressed={view === value}
      aria-label={label}
      title={`${label} (M)`}
      onClick={() => setView(value)}
      className={cx("grid h-6 w-7 place-items-center rounded-[5px] transition-colors", view === value ? "bg-seg text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-text3 hover:text-text")}
    >
      {icon}
    </button>
  );
  return (
    <div role="group" aria-label="View" className="flex shrink-0 gap-0.5 rounded-[7px] bg-raised p-0.5">
      {option("list", "List view", <List size={14} strokeWidth={2} />)}
      {option("map", "Sound map", <MapIcon />)}
    </div>
  );
}
