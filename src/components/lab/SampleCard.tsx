import { Pause, Play } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import type { PitchProfile, SampleRow } from "../../lib/types";
import { usePlayer } from "../../store/player";
import { useUi } from "../../store/ui";
import { useElementWidth } from "../PreviewPanel";
import { Kbd } from "../ui";
import { MiniWave } from "../Waveforms";

/** A sample's stored pitch profile; `loading` until it's read, `profile` null when it has none yet. */
export function usePitchProfile(row: SampleRow | null): { loading: boolean; profile: PitchProfile | null } {
  const [state, setState] = useState<{ id: number; profile: PitchProfile | null } | null>(null);
  const id = row?.id;
  // A sample that finishes analysis comes back with a new status, and a profile.
  const status = row?.status;
  useEffect(() => {
    if (id == null) return;
    let live = true;
    api
      .pitchProfile(id)
      .then((profile) => live && setState({ id, profile }))
      .catch(() => live && setState({ id, profile: null }));
    return () => {
      live = false;
    };
  }, [id, status]);
  if (!row) return { loading: false, profile: null };
  return state?.id === row.id ? { loading: false, profile: state.profile } : { loading: true, profile: null };
}

/** Why a sample has no profile to work from. */
export function missingProfile(row: SampleRow): string {
  if (!row.online) return "This sample's drive isn't connected.";
  if (row.status === 0) return "Saga hasn't listened to this sample yet. It will shortly.";
  if (row.status === 2) return "Saga couldn't read this file.";
  return "Saga is still describing this sample's sound. Try again in a moment.";
}

/** The selected sample in a Lab tool: play it, see what it is, with room for a line about it. */
export function SampleCard({ row, detail }: { row: SampleRow; detail: ReactNode }) {
  const playing = usePlayer((s) => s.id === row.id && (s.status === "playing" || s.status === "loading"));
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return (
    <div className="flex min-h-[54px] items-center gap-3 rounded-[10px] border border-line bg-panel px-3 py-2">
      <button
        type="button"
        onClick={() => usePlayer.getState().toggle(row)}
        aria-label={playing ? `Stop ${row.name}` : `Play ${row.name}`}
        title="Play or stop (Space)"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line2 text-text2 hover:bg-raised hover:text-text"
      >
        {playing ? <Pause size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
      </button>
      <div className="flex max-w-[55%] min-w-0 shrink flex-col gap-px">
        <span className="truncate text-ui font-medium" title={row.name}>
          {row.name}
        </span>
        <span className="truncate text-micro text-text3">{detail}</span>
      </div>
      <div ref={ref} className="h-[30px] min-w-[60px] flex-1">
        {width > 0 && <MiniWave peaks={row.peaks} width={width} height={30} sampleId={row.id} emphasized />}
      </div>
    </div>
  );
}

/** What to do when a Lab tool needs a sample and none is selected. */
export function PickASample({ what }: { what: string }) {
  return (
    <div className="flex min-h-[54px] flex-col justify-center gap-1 rounded-[10px] border border-dashed border-line2 px-4 py-3 text-ui text-text2">
      <span>No sample selected.</span>
      <span className="text-small text-text3">
        Pick one in the{" "}
        <button type="button" onClick={() => useUi.getState().setView("list")} className="text-accent-ink hover:underline">
          list
        </button>{" "}
        to {what}. Back here, <Kbd>↑</Kbd> <Kbd>↓</Kbd> walk through the list.
      </span>
    </div>
  );
}
