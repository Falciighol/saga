import { X } from "lucide-react";
import { fmtTake } from "../../lib/format";
import { usePrefs } from "../../store/prefs";
import { useRecord } from "../../store/record";
import { cx, IconButton } from "../ui";
import { RecordButton, SourceButton, TakeOptionsControls } from "./controls";
import { FirstRun, Stage, StageProblem, StateLabel } from "./Stage";
import { LatestTake, RetentionNote, TakeList, TakesHeader, useVisibleTakes } from "./Takes";

/**
 * The Record panel, beside the list: the source, the live stage, the Record button with how takes start and end, and
 * the takes. It doesn't take the keyboard from the list, so browsing and auditioning go on while a take is armed. In
 * a narrow window it lies over the list instead of pushing it aside.
 */
export function RecordPanel() {
  const source = usePrefs((s) => s.recordSource);
  const problem = useRecord((s) => s.problem);
  return (
    <aside
      aria-label="Record"
      className={cx(
        "flex w-[340px] shrink-0 flex-col border-l border-line bg-panel",
        "max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:shadow-pop",
      )}
    >
      <header className="flex h-11 shrink-0 items-center justify-between pr-2 pl-4">
        <h2 className="m-0 text-title font-semibold">Record</h2>
        <IconButton label="Close (Esc)" size={28} onClick={() => useRecord.getState().setOpen(false)}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="flex shrink-0 flex-col gap-3 px-4 pb-4">
        {source ? (
          <>
            <SourceButton />
            {problem ? <StageProblem /> : <Stage height={124} />}
            <div className="flex items-center gap-4 pt-0.5">
              <RecordButton />
              <TakeOptionsControls />
            </div>
          </>
        ) : (
          <FirstRun />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-line">
        <TakesHeader />
        <TakeList />
        <RetentionNote />
      </div>
    </aside>
  );
}

/**
 * The mini player's record strip, under its header: the Record button and a short live waveform, the source, and
 * the newest take ready to drag. "Takes" swaps the sample list for all of them.
 */
export function MiniRecord() {
  const source = usePrefs((s) => s.recordSource);
  const problem = useRecord((s) => s.problem);
  const miniTakes = useRecord((s) => s.miniTakes);
  const count = useVisibleTakes().length;
  return (
    <>
      <section aria-label="Record" className="flex shrink-0 flex-col gap-2 border-b border-line bg-panel px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <RecordButton size={34} />
          <div className="min-w-0 flex-1">{problem ? <p className="m-0 line-clamp-2 text-small leading-snug text-text2">{problem.message}</p> : <Stage height={38} compact />}</div>
          {!problem && (
            <span className="w-14 shrink-0 text-right">
              <StateLabel compact />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SourceButton compact />
          <div className="flex-1" />
          <button
            type="button"
            aria-pressed={miniTakes}
            title={miniTakes ? "Back to the samples" : "Show all your takes in place of the samples"}
            onClick={() => useRecord.getState().setMiniTakes(!miniTakes)}
            className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-small", miniTakes ? "bg-raised2 text-accent-ink" : "text-text2 hover:bg-raised hover:text-text")}
          >
            Takes
            <span className="font-mono text-micro tabular">{count}</span>
          </button>
        </div>
        {!source && <p className="m-0 text-small text-text3">Pick what to record, then press R.</p>}
      </section>
      {!miniTakes && <LatestTake />}
    </>
  );
}

/** The title bar's Record button, which also shows when something is armed or recording with the panel closed. */
export function RecordToggle() {
  const open = useRecord((s) => s.open);
  const phase = useRecord((s) => s.phase);
  const seconds = useRecord((s) => (s.phase === "recording" ? Math.floor(s.status?.seconds ?? 0) : 0));
  const label = open
    ? "Hide the Record panel"
    : phase === "recording"
      ? "Recording · show the Record panel"
      : phase === "armed"
        ? "Armed · show the Record panel"
        : "Record (R)";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={() => useRecord.getState().setOpen(!open)}
      className={cx(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 transition-colors",
        open ? "bg-raised2" : "hover:bg-raised",
        phase === "recording" ? "text-rec" : open ? "text-text" : "text-text2 hover:text-text",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "grid h-4 w-4 place-items-center rounded-full border-[1.5px]",
          phase === "recording" ? "border-rec" : phase === "armed" ? "animate-rec-blink border-rec" : "border-current",
        )}
      >
        <span className={cx("block h-2 w-2 rounded-full", phase === "armed" ? "border border-rec" : "bg-rec")} />
      </span>
      {phase === "recording" && <span className="font-mono text-small tabular">{fmtTake(seconds).replace(/\.\d$/, "")}</span>}
    </button>
  );
}
