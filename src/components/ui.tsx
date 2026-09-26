import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Switch({
  checked,
  onChange,
  label,
  size = "md",
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  const w = size === "sm" ? 22 : 26;
  const h = size === "sm" ? 14 : 16;
  const knob = h - 4;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx("flex items-center gap-2 text-ui text-text2", className)}
    >
      {label != null && <span className="min-w-0 flex-1 text-left">{label}</span>}
      <span
        className="relative shrink-0 rounded-full transition-colors"
        style={{ width: w, height: h, background: checked ? "var(--accent)" : "var(--raised2)" }}
      >
        <span
          className="absolute top-[2px] left-[2px] rounded-full transition-transform duration-150"
          style={{
            width: knob,
            height: knob,
            background: checked ? "var(--on-accent)" : "var(--text3)",
            transform: `translateX(${checked ? w - knob - 4 : 0}px)`,
          }}
        />
      </span>
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = "md",
  label,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx("flex shrink-0 gap-0.5 rounded-lg bg-raised p-[3px]", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            title={o.title}
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cx(
              "flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors",
              size === "sm" ? "h-[22px] px-2 text-small" : "h-[26px] px-3 text-ui",
              on ? "bg-seg text-text shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-text2 hover:text-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function IconButton({
  label,
  children,
  active,
  className,
  size = 32,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      style={{ width: size, height: size, ...rest.style }}
      className={cx(
        "grid shrink-0 place-items-center rounded-lg transition-colors disabled:opacity-40",
        active ? "bg-raised2 text-accent-ink" : "text-text2 hover:bg-raised hover:text-text",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("text-micro font-semibold tracking-[0.06em] text-text3 uppercase", className)}>{children}</div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx("h-5 w-px shrink-0 bg-line2", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-line2 px-1.5 py-px font-mono text-micro text-text3">{children}</span>
  );
}
