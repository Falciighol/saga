import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "error" | "info";
  /** A button on the toast, such as Undo. */
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, tone?: Toast["tone"], action?: Toast["action"]) => void;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, tone = "error", action) => {
    // Repeating the same message (e.g. holding an arrow over broken files) shouldn't stack.
    if (get().toasts.some((t) => t.message === message)) return;
    const id = next++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, tone, action }] }));
    // Longer when there's something to do about it.
    window.setTimeout(() => get().dismiss(id), action ? 10_000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (message: string, tone?: Toast["tone"], action?: Toast["action"]) => useToasts.getState().push(message, tone, action);
