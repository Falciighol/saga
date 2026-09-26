import { PictureInPicture2, Search, Settings2, X } from "lucide-react";
import { forwardRef } from "react";
import { fmtCount } from "../lib/format";
import { isMac, isWindows, modKey } from "../lib/platform";
import { useBrowse } from "../store/browse";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";
import { ProjectControls } from "./ProjectControls";
import { cx, Divider, IconButton, Kbd } from "./ui";
import { WindowControls } from "./WindowControls";

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="174 174.5 731 731" aria-hidden="true" className="fill-text">
      <path d="M843 431.47C843 414.228 856.879 400.25 874 400.25C891.121 400.25 905 414.228 905 431.47L905 735.03C905 752.272 891.121 766.25 874 766.25C856.879 766.25 843 752.272 843 735.03L843 431.47Z" />
      <path d="M731 320.523C731 303.251 745.103 289.25 762.5 289.25C779.897 289.25 794 303.251 794 320.523L794 843.977C794 861.249 779.897 875.25 762.5 875.25C745.103 875.25 731 861.249 731 843.977L731 320.523Z" />
      <path d="M619 520.646C619 507.173 633.103 496.25 650.5 496.25C667.897 496.25 682 507.173 682 520.646L682 757.854C682 771.327 667.897 782.25 650.5 782.25C633.103 782.25 619 771.327 619 757.854L619 520.646Z" />
      <path d="M509 548.218C509 540.332 513.98 518.25 539.5 518.25C565.02 518.25 570 540.332 570 548.218L570 861.047C570 873.444 561.908 887.25 539.5 887.25C517.092 887.25 509 874.071 509 861.047L509 548.218Z" />
      <path d="M397 519.646C397 506.173 411.103 495.25 428.5 495.25C445.897 495.25 460 506.173 460 519.646L460 756.854C460 770.327 445.897 781.25 428.5 781.25C411.103 781.25 397 770.327 397 756.854L397 519.646Z" />
      <path d="M285 321.523C285 304.251 299.103 290.25 316.5 290.25C333.897 290.25 348 304.251 348 321.523L348 844.977C348 862.249 333.897 876.25 316.5 876.25C299.103 876.25 285 862.249 285 844.977L285 321.523Z" />
      <path d="M174 432.385C174 415.19 187.879 401.25 205 401.25C222.121 401.25 236 415.19 236 432.385L236 735.115C236 752.31 222.121 766.25 205 766.25C187.879 766.25 174 752.31 174 735.115L174 432.385Z" />
      <path d="M632 335C632 284.19 590.81 243 540 243C489.19 243 448 284.19 448 335C448 385.81 489.19 427 540 427V477C461.576 477 398 413.424 398 335C398 256.576 461.576 193 540 193C618.424 193 682 256.576 682 335C682 413.424 618.424 477 540 477V427C590.81 427 632 385.81 632 335Z" />
    </svg>
  );
}

export const TitleBar = forwardRef<HTMLInputElement, { onOpenSettings: () => void }>(function TitleBar({ onOpenSettings }, searchRef) {
  const text = useBrowse((s) => s.text);
  const setText = useBrowse((s) => s.setText);
  const total = useLibrary((s) => s.stats?.total ?? 0);

  return (
    <header data-tauri-drag-region className={cx("flex h-12 shrink-0 items-center gap-3.5 border-b border-line bg-panel", isWindows ? "pr-0" : "pr-4")}>
      <div data-tauri-drag-region className="flex w-58 shrink-0 items-center gap-2.5" style={{ paddingLeft: isMac ? 90 : 16 }}>
        <Logo size={22} />
        <span data-tauri-drag-region className="text-[16px] font-semibold tracking-[-0.01em]">
          Saga
        </span>
      </div>
      <label className="flex h-8 max-w-[640px] min-w-0 flex-1 items-center gap-2.5 rounded-lg bg-raised pr-2 pl-3 text-text3 focus-within:ring-1 focus-within:ring-line2">
        <Search size={15} strokeWidth={2} aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          spellCheck={false}
          autoCorrect="off"
          aria-label="Search samples"
          placeholder={total ? `Search ${fmtCount(total)} samples — try “dusty kick” or bpm:120-128` : "Search samples"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text3"
        />
        {text ? (
          <button type="button" aria-label="Clear search" onClick={() => setText("")} className="grid h-5 w-5 place-items-center rounded text-text3 hover:text-text">
            <X size={14} />
          </button>
        ) : (
          <Kbd>{modKey}K</Kbd>
        )}
      </label>
      <div data-tauri-drag-region className="h-full flex-1" />
      <ProjectControls />
      <Divider />
      <IconButton label="Switch to the mini player" title="Mini player: a small window that stays next to your DAW" onClick={() => useUi.getState().setMini(true)}>
        <PictureInPicture2 size={16} strokeWidth={1.75} />
      </IconButton>
      <IconButton label="Settings" onClick={onOpenSettings}>
        <Settings2 size={16} strokeWidth={1.75} />
      </IconButton>
      <WindowControls />
    </header>
  );
});
