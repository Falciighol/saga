import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

interface PromptRequest {
  title: string;
  placeholder?: string;
  initial?: string;
  confirm: string;
  onSubmit: (value: string) => void;
}

interface PromptState {
  request: PromptRequest | null;
  ask: (r: PromptRequest) => void;
  close: () => void;
}

export const usePrompt = create<PromptState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function PromptHost() {
  const request = usePrompt((s) => s.request);
  const close = usePrompt((s) => s.close);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (request) {
      setValue(request.initial ?? "");
      requestAnimationFrame(() => input.current?.select());
    }
  }, [request]);

  if (!request) return null;
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    request.onSubmit(v);
    close();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-(--overlay)" onMouseDown={close}>
      <form
        role="dialog"
        aria-label={request.title}
        className="animate-pop w-[380px] rounded-2xl border border-line2 bg-panel p-5 shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
      >
        <label className="flex flex-col gap-3">
          <span className="text-title font-semibold">{request.title}</span>
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={request.placeholder}
            className="h-9 rounded-lg border border-line2 bg-raised px-3 text-body text-text outline-none placeholder:text-text3 focus:border-accent"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={close} className="h-8 rounded-lg px-3 text-ui text-text2 hover:bg-raised">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!value.trim()}
            className="h-8 rounded-lg bg-accent px-3.5 text-ui font-semibold text-on-accent disabled:opacity-40"
          >
            {request.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
