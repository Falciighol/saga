import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SuggestedFolder } from "../lib/types";
import { reviewFolders } from "./AddFolders";
import { chooseFolders } from "./Sidebar";
import { SectionLabel } from "./ui";

/** First run: no folders in the library yet. */
export function Welcome() {
  const [suggested, setSuggested] = useState<SuggestedFolder[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .suggestedFolders()
      .then((list) => {
        setSuggested(list);
        setPicked(Object.fromEntries(list.map((f) => [f.path, true])));
      })
      .catch(() => {});
  }, []);

  const chosen = suggested.filter((f) => picked[f.path]).map((f) => f.path);

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-10 pt-[9vh] pb-10">
      <div className="flex w-full max-w-[560px] flex-col gap-7">
        <div className="flex flex-col gap-3">
          <h1 className="m-0 text-[32px] leading-[1.1] font-semibold tracking-[-0.03em]">Point Saga at your samples.</h1>
          <p className="m-0 max-w-[480px] text-[14.5px] leading-normal text-pretty text-text2">
            Saga indexes folders where they already are. Nothing gets moved, copied or renamed, and you can browse while it reads tempo, key and waveforms.
          </p>
        </div>

        <div className="flex h-[132px] flex-col items-center justify-center gap-2.5 rounded-xl border-[1.5px] border-dashed border-line2 bg-panel">
          <Folder size={22} strokeWidth={1.75} className="text-text3" aria-hidden="true" />
          <div className="flex items-center gap-2.5 text-[13.5px] text-text2">
            <span>Drop folders or drives here</span>
            <span className="text-text3">or</span>
            <button type="button" onClick={() => void chooseFolders()} className="h-[30px] rounded-lg border border-line2 px-3 text-ui text-text hover:bg-raised">
              Choose folders…
            </button>
          </div>
        </div>

        {suggested.length > 0 && (
          <div className="flex flex-col gap-1">
            <SectionLabel className="pb-1.5">Found on this computer</SectionLabel>
            {suggested.map((f) => (
              <label key={f.path} className="flex h-10 items-center gap-3 rounded-lg bg-panel px-3">
                <input
                  type="checkbox"
                  checked={!!picked[f.path]}
                  onChange={(e) => setPicked((p) => ({ ...p, [f.path]: e.target.checked }))}
                  className="h-[15px] w-[15px]"
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ui">{f.path}</span>
                <span className="text-small text-text3">{f.label}</span>
              </label>
            ))}
            <button
              type="button"
              disabled={chosen.length === 0}
              onClick={() => void reviewFolders(chosen)}
              className="mt-3 h-[42px] rounded-[10px] bg-accent text-[14px] font-semibold text-on-accent disabled:opacity-40"
            >
              Add {chosen.length === 1 ? "this folder" : `${chosen.length} folders`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
