import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { type ToastTone as SharedToastTone } from "../../../lib/ui/toasts";
import { uid } from "../data";
import { Toast, type ToastTone as BrandToastTone } from "./brand/Toast";

/**
 * Toast tones rendered by the console. The shared model in lib/ui/toasts.ts
 * knows info/error/success only, so the warning variant is widened here — the
 * shared file is out of scope for this change.
 */
export type ToastTone = SharedToastTone | "warning";

/** One toast on screen. `ttlMs` of 0 keeps it until it is dismissed by hand. */
interface ToastEntry {
  id: string;
  tone: ToastTone;
  message: string;
  detail?: string;
  action?: () => void;
  /** Auto-dismiss window in ms. */
  ttlMs: number;
}

interface PushInput {
  tone?: ToastTone;
  message: string;
  detail?: string;
  action?: () => void;
  ttlMs?: number;
}

interface ToastsValue {
  toasts: readonly ToastEntry[];
  push: (input: PushInput) => void;
  dismiss: (id: string) => void;
}

const ToastsContext = createContext<ToastsValue | null>(null);

/**
 * Provider tones mapped onto the brand Toast tones. The brand Toast owns the
 * card chrome (icon, border, Void Navy surface); this provider keeps owning
 * the behaviour — auto-dismiss timers, hover pause, the leave animation and
 * the draining progress bar — so the brand Toast is rendered sticky
 * (durationMs: 0) and dismissed by the provider.
 */
const BRAND_TONE: Record<ToastTone, BrandToastTone> = {
  info: "info",
  success: "ok",
  warning: "warn",
  error: "err",
};

/** Drain-bar colour per provider tone, matching the brand tone. */
const TONE_BAR: Record<ToastTone, string> = {
  info: "bg-cyan-300/90",
  success: "bg-emerald-400/90",
  warning: "bg-amber-300/90",
  error: "bg-red-400/90",
};

/** At most four toasts are on screen; the oldest one falls off when it overflows. */
const MAX_VISIBLE = 4;
/** Default auto-dismiss window in ms. */
const DEFAULT_TTL = 8000;
/** How long the leave animation runs before the toast leaves the DOM. */
const EXIT_MS = 180;

type StackAction = { type: "add"; toast: ToastEntry } | { type: "remove"; id: string };

function toastStackReducer(state: readonly ToastEntry[], action: StackAction): ToastEntry[] {
  switch (action.type) {
    case "add":
      return [...state, action.toast].slice(-MAX_VISIBLE);
    case "remove":
      return state.filter((toast) => toast.id !== action.id);
  }
}

/** Auto-dismiss timer for one toast. `handle` is null while the timer is paused. */
interface ToastTimer {
  /** Wall-clock ms at which the toast should auto-dismiss. */
  deadline: number;
  handle: number | null;
}

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (ids.has(id)) return ids;
  const next = new Set(ids);
  next.add(id);
  return next;
}

function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/**
 * Toast chrome lives here (the shared CSS file is out of scope for this
 * change): a slide-in from the bottom-right, a fade-in under reduced motion,
 * a leave animation, and the draining auto-dismiss bar.
 */
const TOAST_CSS = `
.sa-toast { animation: sa-toast-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both; }
.sa-toast[data-leaving="true"] { animation: sa-toast-out 180ms cubic-bezier(0.4, 0, 1, 1) forwards; }
.sa-toast-progress { transform-origin: left center; animation: sa-toast-drain var(--sa-toast-ttl, 8000ms) linear both; }
.sa-toast-progress[data-paused="true"] { animation-play-state: paused; }
@keyframes sa-toast-in {
  from { opacity: 0; transform: translate3d(1.25rem, 0.75rem, 0) scale(0.97); }
  to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
}
@keyframes sa-toast-out {
  from { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
  to { opacity: 0; transform: translate3d(0.75rem, 0.25rem, 0) scale(0.97); }
}
@keyframes sa-toast-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes sa-toast-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes sa-toast-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) {
  .sa-toast { animation-name: sa-toast-fade-in; animation-duration: 160ms !important; }
  .sa-toast[data-leaving="true"] { animation-name: sa-toast-fade-out; animation-duration: 160ms !important; }
  .sa-toast-progress { animation-duration: var(--sa-toast-ttl, 8000ms) !important; }
}
`;

/**
 * t14r — dismissible toast system for provider/network failures (and
 * info/success/warning).
 *
 * The visible stack is local to this component: the shared model in
 * lib/ui/toasts.ts carries only the three original tones and no auto-dismiss
 * window, and that file is out of scope for this change. Everything the toast
 * needs at runtime — dismissal, the auto-dismiss window, hover pause, the
 * stacking cap — is UI behaviour that belongs to the component.
 */
export function ToastsProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastStackReducer, []);
  /** Toasts that are playing their leave animation. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  /** Toasts whose auto-dismiss timer is paused (hover/focus). */
  const [paused, setPaused] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, ToastTimer>());
  const exitTimers = useRef(new Map<string, number>());

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer?.handle != null) window.clearTimeout(timer.handle);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setPaused((prev) => withoutId(prev, id));
      if (exitTimers.current.has(id)) return;
      setLeaving((prev) => withId(prev, id));
      const handle = window.setTimeout(() => {
        exitTimers.current.delete(id);
        dispatch({ type: "remove", id });
        setLeaving((prev) => withoutId(prev, id));
      }, EXIT_MS);
      exitTimers.current.set(id, handle);
    },
    [clearTimer],
  );

  const push = useCallback(
    (input: PushInput) => {
      const id = uid();
      const ttl = input.ttlMs ?? DEFAULT_TTL;
      dispatch({
        type: "add",
        toast: {
          id,
          tone: input.tone ?? "info",
          message: input.message,
          detail: input.detail,
          action: input.action,
          ttlMs: ttl,
        },
      });
      // Auto-dismiss unless the caller opted out with ttlMs: 0.
      if (ttl > 0) {
        const handle = window.setTimeout(() => {
          timers.current.delete(id);
          dismiss(id);
        }, ttl);
        timers.current.set(id, { deadline: Date.now() + ttl, handle });
      }
    },
    [dismiss],
  );

  /** Hover/focus pauses both the auto-dismiss timer and the progress bar. */
  const pause = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (!timer || timer.handle == null) return;
    window.clearTimeout(timer.handle);
    timers.current.set(id, { deadline: timer.deadline, handle: null });
    setPaused((prev) => withId(prev, id));
  }, []);

  const resume = useCallback(
    (id: string) => {
      const timer = timers.current.get(id);
      if (!timer || timer.handle != null) return;
      const remaining = timer.deadline - Date.now();
      setPaused((prev) => withoutId(prev, id));
      if (remaining <= 0) {
        dismiss(id);
        return;
      }
      const handle = window.setTimeout(() => {
        timers.current.delete(id);
        dismiss(id);
      }, remaining);
      timers.current.set(id, { deadline: Date.now() + remaining, handle });
    },
    [dismiss],
  );

  // Never leave a timer running after the provider goes away.
  useEffect(
    () => () => {
      timers.current.forEach((timer) => {
        if (timer.handle != null) window.clearTimeout(timer.handle);
      });
      timers.current.clear();
      exitTimers.current.forEach((handle) => window.clearTimeout(handle));
      exitTimers.current.clear();
    },
    [],
  );

  const value = useMemo<ToastsValue>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastsContext.Provider value={value}>
      {children}
      <style dangerouslySetInnerHTML={{ __html: TOAST_CSS }} />
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-stretch gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+12.5rem)] pt-3 sm:left-auto sm:right-4 sm:bottom-4 sm:w-[min(92vw,22rem)] sm:items-end sm:px-0 sm:pb-0 sm:pt-0">
          {toasts.map((toast) => {
            const isPaused = paused.has(toast.id);
            const isLeaving = leaving.has(toast.id);
            const sticky = toast.ttlMs <= 0;
            return (
              <div
                key={toast.id}
                data-testid="toast"
                data-tone={toast.tone}
                data-leaving={isLeaving ? "true" : undefined}
                onMouseEnter={() => pause(toast.id)}
                onMouseLeave={() => resume(toast.id)}
                onFocusCapture={() => pause(toast.id)}
                onBlurCapture={() => resume(toast.id)}
                className="sa-toast pointer-events-auto relative w-[min(360px,92vw)] overflow-hidden rounded-[var(--brand-radius-lg)] max-sm:mx-auto"
              >
                <Toast
                  toast={{
                    id: toast.id,
                    tone: BRAND_TONE[toast.tone],
                    title: toast.message,
                    description: toast.detail,
                    // Sticky: the provider owns auto-dismiss (and hover pause).
                    durationMs: 0,
                    actionLabel: toast.action ? "Open" : undefined,
                    onAction: toast.action
                      ? () => {
                          toast.action?.();
                          dismiss(toast.id);
                        }
                      : undefined,
                  }}
                  onDismiss={dismiss}
                />
                {!sticky && (
                  <div
                    data-testid="toast-progress"
                    data-paused={isPaused ? "true" : undefined}
                    className={`sa-toast-progress absolute inset-x-0 bottom-0 h-[2px] ${TONE_BAR[toast.tone]}`}
                    style={{ "--sa-toast-ttl": `${toast.ttlMs}ms` } as CSSProperties}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ToastsContext.Provider>
  );
}

export function useToasts(): ToastsValue {
  const ctx = useContext(ToastsContext);
  if (!ctx) throw new Error("useToasts must be used within a ToastsProvider");
  return ctx;
}
