import { useCallback, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../utils/cn";

export type MynowAgentState = "idle" | "thinking" | "acting" | "waiting" | "error";

/* ---------- Pressable: spring press, cursor ripple, glint sweep, haptic tick ---------- */
type PressProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" | "glass" | "line"; size?: "sm" | "md" | "lg" | "icon" };
export function Press({ className, variant = "ghost", size = "md", onPointerDown, children, ...rest }: PressProps) {
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number; s: number }[]>([]);
  const n = useRef(0);
  return (
    <button
      {...rest}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const s = Math.max(r.width, r.height) * 2.4;
        const id = ++n.current;
        setRipples((p) => [...p, { id, x: e.clientX - r.left, y: e.clientY - r.top, s }]);
        setTimeout(() => setRipples((p) => p.filter((q) => q.id !== id)), 750);
        try { navigator.vibrate?.(4); } catch { /* noop */ }
        onPointerDown?.(e);
      }}
      className={cn(
        "press inline-flex items-center justify-center gap-2 font-medium outline-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[var(--fg)]/40 cursor-pointer",
        size === "sm" && "h-8 px-3 text-[12.5px] rounded-full",
        size === "md" && "h-10 px-4 text-[13.5px] rounded-full",
        size === "lg" && "h-12 px-6 text-[15px] rounded-full",
        size === "icon" && "h-9 w-9 rounded-full",
        variant === "solid" && "bg-[var(--fg)] text-[var(--inv)] hover:shadow-[0_10px_30px_-10px_var(--fg)]",
        variant === "ghost" && "text-[var(--fg-2)] hover:text-[var(--fg)] hover:bg-[var(--line)]",
        variant === "glass" && "glass text-[var(--fg)] hover:bg-[var(--glass-2)]",
        variant === "line" && "hair text-[var(--fg)] hover:bg-[var(--line)] hover:border-[var(--line-2)]",
        className,
      )}
    >
      {ripples.map((r) => (
        <span key={r.id} className="ripple" style={{ left: r.x, top: r.y, width: r.s, height: r.s }} />
      ))}
      {children}
    </button>
  );
}

/* ---------- Edge card: luminous border that follows the cursor ---------- */
export function Edge({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = useCallback((e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, []);
  return (
    <div ref={ref} onPointerMove={onMove} className={cn("edge", className)} {...rest}>
      {children}
    </div>
  );
}

/* ---------- Essence ---------- */
export function Orb({ size = 28, state = "idle", className }: { size?: number; state?: MynowAgentState; className?: string }) {
  return (
    <div className={cn("orb shrink-0", className)} data-state={state} style={{ width: size, height: size }}>
      <div className="orb-glow" />
      <div className="orb-core" />
    </div>
  );
}

export function Dot({ tone = "mute", pulse }: { tone?: "ok" | "warn" | "err" | "mute" | "fg" | "sig"; pulse?: boolean }) {
  const c = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", mute: "var(--mute)", fg: "var(--fg)", sig: "var(--sig)" }[tone];
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", pulse && "pulse-dot")} style={{ background: c, color: c }} />;
}

export function Pill({ children, className, tone }: { children: ReactNode; className?: string; tone?: "ok" | "warn" | "err" | "sig" }) {
  const c = tone ? { ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", sig: "var(--sig)" }[tone] : undefined;
  return (
    <span
      className={cn("mono inline-flex items-center gap-1 rounded-full px-2 h-5 text-[10.5px] hair text-[var(--fg-2)] whitespace-nowrap", className)}
      style={c ? { color: c, borderColor: `color-mix(in srgb, ${c} 35%, transparent)`, background: `color-mix(in srgb, ${c} 8%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mono inline-flex items-center h-5 min-w-5 justify-center px-1.5 rounded-md hair text-[10.5px] text-[var(--mute)] bg-[var(--line)]">{children}</kbd>;
}

export function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("check-draw", className)} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("spin", className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Icons ---------- */
const I = ({ d, className, sw = 1.7 }: { d: ReactNode; className?: string; sw?: number }) => (
  <svg viewBox="0 0 24 24" className={cn("h-4 w-4", className)} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);
export const Icon = {
  plus: (p: { className?: string }) => <I {...p} d={<path d="M12 5v14M5 12h14" />} />,
  arrowUp: (p: { className?: string }) => <I {...p} sw={2.2} d={<path d="M12 19V5M6 11l6-6 6 6" />} />,
  stop: (p: { className?: string }) => <svg viewBox="0 0 24 24" className={cn("h-3.5 w-3.5", p.className)} fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>,
  plug: (p: { className?: string }) => <I {...p} d={<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />} />,
  box: (p: { className?: string }) => <I {...p} d={<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>} />,
  pulse: (p: { className?: string }) => <I {...p} d={<path d="M3 12h4l3-8 4 16 3-8h4" />} />,
  list: (p: { className?: string }) => <I {...p} d={<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />} />,
  chevron: (p: { className?: string }) => <I {...p} d={<path d="m9 6 6 6-6 6" />} />,
  sun: (p: { className?: string }) => <I {...p} d={<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>} />,
  moon: (p: { className?: string }) => <I {...p} d={<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />} />,
  x: (p: { className?: string }) => <I {...p} d={<path d="M6 6l12 12M18 6 6 18" />} />,
  panel: (p: { className?: string }) => <I {...p} d={<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>} />,
  sidebar: (p: { className?: string }) => <I {...p} d={<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>} />,
  ext: (p: { className?: string }) => <I {...p} d={<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />} />,
  shield: (p: { className?: string }) => <I {...p} d={<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" />} />,
  bolt: (p: { className?: string }) => <I {...p} d={<path d="M13 2 4 14h7l-1 8 9-12h-7z" />} />,
  copy: (p: { className?: string }) => <I {...p} d={<><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>} />,
  trash: (p: { className?: string }) => <I {...p} d={<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />} />,
  star: (p: { className?: string }) => <I {...p} d={<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />} />,
  fork: (p: { className?: string }) => <I {...p} d={<><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" /></>} />,
  attach: (p: { className?: string }) => <I {...p} d={<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7.2" />} />,
  globe: (p: { className?: string }) => <I {...p} d={<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></>} />,
};

export function useCopy() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (s: string) => {
      navigator.clipboard?.writeText(s).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    },
  };
}
