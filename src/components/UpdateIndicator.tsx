import { Download } from "lucide-react";
import { useUpdates } from "../store/updates";
import { cx, IconButton } from "./ui";

/**
 * Title bar status for a new version: a progress bar while it downloads, then a download button
 * that restarts into it. Unlike the restart notice it stays after "Later".
 */
export function UpdateIndicator() {
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.version);
  const progress = useUpdates((s) => s.progress);

  if (status === "downloading") {
    const pct = progress === null ? null : Math.round(progress * 100);
    const label = `Downloading Saga ${version}${pct === null ? "…" : ` — ${pct}%`}`;
    return (
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        title={label}
        className="flex h-8 shrink-0 items-center px-1"
      >
        <div className="h-1 w-14 overflow-hidden rounded-full bg-raised2">
          <div
            className={cx("h-full rounded-full bg-accent", pct === null ? "animate-soft-pulse w-full" : "transition-[width] duration-200")}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (status === "ready" || status === "installing") {
    const installing = status === "installing";
    return (
      <IconButton
        label={installing ? "Restarting…" : `Restart to update to Saga ${version}`}
        disabled={installing}
        onClick={() => void useUpdates.getState().restart()}
      >
        <Download size={16} strokeWidth={1.75} className={cx("text-accent-ink", installing && "animate-soft-pulse")} />
      </IconButton>
    );
  }

  return null;
}
