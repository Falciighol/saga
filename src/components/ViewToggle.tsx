import { List } from "lucide-react";
import { useLab } from "../store/lab";
import { useUi, type MainView } from "../store/ui";
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

export function ScaleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v3M20.5 12h-3M12 20.5v-3M3.5 12h3" />
      <path d="m8.5 9 3.5 3 3-1.5" />
    </svg>
  );
}

/** Switches between the list, the sound map and the Lab. */
export function ViewToggle() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  // A progression keeps looping while you browse, so the Lab button shows it's the source.
  const looping = useLab((s) => s.transport.playing);
  const option = (value: MainView, label: string, key: string, icon: React.ReactNode, dot = false) => (
    <button
      type="button"
      aria-pressed={view === value}
      aria-label={label}
      title={`${label} (${key})`}
      onClick={() => setView(value)}
      className={cx(
        "relative grid h-6 w-7 place-items-center rounded-[5px] transition-colors",
        view === value ? "bg-seg text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-text3 hover:text-text",
      )}
    >
      {icon}
      {dot && <span aria-hidden="true" className="animate-soft-pulse absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  );
  return (
    <div role="group" aria-label="View" className="flex shrink-0 gap-0.5 rounded-[7px] bg-raised p-0.5">
      {option("list", "List view", "M", <List size={14} strokeWidth={2} />)}
      {option("map", "Sound map", "M", <MapIcon />)}
      {option("lab", looping ? "Lab: a progression is playing" : "Lab: scales and progressions", "H", <ScaleIcon size={14} />, looping)}
    </div>
  );
}
