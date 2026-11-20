"use client";

import React, { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, ChevronDown, Check, UserRound } from "lucide-react";
import { ROLES, type RotationStrategy, type ProviderConfig } from "../data";
import { RoleIcon } from "./RoleIcon";

interface RoleAndVmBarProps {
  activeRoleId: string;
  onSelectRole: (roleId: string) => void;
  rotationStrategy: RotationStrategy;
  onChangeRotationStrategy: (strategy: RotationStrategy) => void;
  providers: ProviderConfig[];
  onOpenSettings: () => void;
  onResetVm: () => void;
  vmResetting: boolean;
  onToggleView: (view: "telemetry" | "desktop" | "terminal" | "browser" | "files") => void;
  activeView: "telemetry" | "desktop" | "terminal" | "browser" | "files";
  /** The user's agent card text (used for the compact "Agent" strip preview). */
  agentCard: string;
  /** Open the full Agent Card dialog. */
  onOpenAgentCard: () => void;
}

const strategyOptions: { value: RotationStrategy; label: string; hint: string }[] = [
  { value: "ranked_fallback", label: "Fallback", hint: "1st → 2nd → 3rd" },
  { value: "round_robin", label: "Round Robin", hint: "Rotate providers evenly" },
  { value: "racing", label: "Racing", hint: "Lowest latency wins" },
  { value: "random", label: "Random", hint: "Random load balance" },
];

export interface MenuPlacementOptions {
  align?: "left" | "right";
  width: number;
  /** Minimum gap from the viewport edges (default 8). */
  padding?: number;
  /** Vertical gap below the trigger (default 6). */
  gap?: number;
}

/**
 * Compute the fixed viewport position for a floating menu anchored to a
 * trigger button. Pure so it is unit-testable: the menu must never extend
 * past the viewport edges (the old inline dropdown could drift off-screen or
 * under other layers on later opens).
 */
export function placeMenu(
  anchor: { left: number; right: number; bottom: number },
  viewportWidth: number,
  opts: MenuPlacementOptions,
): { top: number; left: number } {
  const pad = opts.padding ?? 8;
  const gap = opts.gap ?? 6;
  const desiredLeft = opts.align === "right" ? anchor.right - opts.width : anchor.left;
  const left = Math.max(pad, Math.min(desiredLeft, viewportWidth - opts.width - pad));
  return { top: anchor.bottom + gap, left };
}

/**
 * Shared behavior for a trigger-anchored dropdown that is portaled to
 * <body>: it escapes the bar's backdrop-filter stacking context (which used
 * to trap the menu's z-index inside an early DOM sibling, so the computer
 * screen painted over it and swallowed clicks), and it closes on Escape or on
 * any pointer press outside the trigger and panel.
 */
function useFloatingMenu(
  open: boolean,
  onClose: () => void,
  anchorRef: RefObject<HTMLButtonElement | null>,
  align: "left" | "right" = "left",
) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hadFocusRef = useRef(false);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const placed = placeMenu({ left: rect.left, right: rect.right, bottom: rect.bottom }, window.innerWidth, {
      align,
      width: panel.offsetWidth,
    });
    // The composer pins its triggers to the bottom of the viewport, so a
    // below-anchor menu (the old placement) lands off-screen. Flip it above
    // the trigger when it would overflow the bottom edge.
    const height = panel.offsetHeight;
    const top =
      placed.top + height > window.innerHeight - 8
        ? Math.max(8, rect.top - 6 - height)
        : placed.top;
    setPos({ top, left: placed.left });
  }, [anchorRef, align]);

  // Place the panel below the trigger on open; re-clamp if the viewport
  // scrolls or resizes while it is open so it never drifts under other UI.
  useEffect(() => {
    if (!open) return;
    const frame = () => reposition();
    frame();
    window.addEventListener("resize", frame);
    window.addEventListener("scroll", frame, true);
    return () => {
      window.removeEventListener("resize", frame);
      window.removeEventListener("scroll", frame, true);
    };
  }, [open, reposition]);

  // Escape closes while this menu is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Any pointer press outside the trigger or the panel closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open, onClose, anchorRef]);

  // Track whether keyboard focus is inside the panel so we can hand focus
  // back to the trigger when the menu closes (select / Escape / outside click).
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const onFocusIn = (e: FocusEvent) => {
      if (panel.contains(e.target as Node)) hadFocusRef.current = true;
    };
    panel.addEventListener("focusin", onFocusIn);
    return () => panel.removeEventListener("focusin", onFocusIn);
  }, [open]);

  useEffect(() => {
    if (open) return;
    if (hadFocusRef.current) {
      anchorRef.current?.focus();
      hadFocusRef.current = false;
    }
  }, [open, anchorRef]);

  return { pos, panelRef };
}

interface FloatingMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  align?: "left" | "right";
  menuRole?: string;
  ariaLabel?: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Dropdown panel rendered through a portal onto <body>. The portal is the key
 * to the stacking fix: an inline z-50 menu lives inside the bar's
 * backdrop-filter stacking context, so as a whole it paints below the
 * computer screen that follows the bar in DOM order — the screen then
 * intercepts every click on the menu. As a body child with a high z-index,
 * the menu paints above everything and hit-testing reaches its items.
 */
function FloatingMenu({
  open,
  anchorRef,
  onClose,
  align,
  menuRole,
  ariaLabel,
  testId,
  className,
  children,
}: FloatingMenuProps) {
  const { pos, panelRef } = useFloatingMenu(open, onClose, anchorRef, align);
  if (!open || typeof document === "undefined") return null;
  const style: CSSProperties = {
    top: pos.top,
    left: pos.left,
    position: "fixed",
  };
  return createPortal(
    <div
      ref={panelRef}
      role={menuRole}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`z-50 ${className ?? ""}`}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}

interface RoleMenuPanelProps {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  activeRoleId: string;
  onSelectRole: (roleId: string) => void;
  onClose: () => void;
}

export function RoleMenuPanel({ open, anchorRef, activeRoleId, onSelectRole, onClose }: RoleMenuPanelProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Keyboard navigation: arrow keys / Home / End move focus between items.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    switch (e.key) {
      case "ArrowDown":
        next = (current + 1) % items.length;
        break;
      case "ArrowUp":
        next = (current - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  };

  // When the menu opens, focus the active role so keyboard users can arrow
  // through the list without tabbing across the page first.
  useEffect(() => {
    if (!open) return;
    const selected = ROLES.findIndex((r) => r.id === activeRoleId);
    (itemRefs.current[selected] ?? itemRefs.current[0])?.focus();
  }, [open, activeRoleId]);

  return (
    <FloatingMenu
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      menuRole="menu"
      ariaLabel="Switch agent role and tools"
      testId="role-menu-panel"
      className="w-72 bg-[#121218] border border-white/15 rounded-2xl shadow-2xl p-2 backdrop-blur-2xl"
    >
      <div className="text-[10px] font-semibold text-white/40 uppercase px-2 py-1 tracking-wider">
        Switch Agent Role & Tools
      </div>
      <div className="flex flex-col gap-1 mt-1" onKeyDown={onKeyDown}>
        {ROLES.map((r, index) => {
          const selected = r.id === activeRoleId;
          return (
            <button
              key={r.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              role="menuitemradio"
              aria-checked={selected}
              data-role-id={r.id}
              onClick={() => {
                onSelectRole(r.id);
                onClose();
              }}
              className={`flex items-start gap-2.5 p-2 rounded-xl text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
                selected ? "bg-white/15 text-white" : "hover:bg-white/5 text-white/80"
              }`}
            >
              <div
                className="w-6 h-6 rounded-lg grid place-items-center shrink-0 mt-0.5"
                style={{
                  background: `hsl(${r.hue} 70% 60% / 0.2)`,
                  color: `hsl(${r.hue} 80% 75%)`,
                }}
              >
                <RoleIcon name={r.icon} className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="text-xs font-medium">{r.name}</div>
                <div className="text-[10px] text-white/40 leading-tight">{r.blurb}</div>
              </div>
              {selected && <Check className="w-3.5 h-3.5 shrink-0 text-indigo-300 ml-auto mt-0.5" />}
            </button>
          );
        })}
      </div>
    </FloatingMenu>
  );
}

interface StrategyMenuPanelProps {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  rotationStrategy: RotationStrategy;
  onChangeRotationStrategy: (strategy: RotationStrategy) => void;
  onClose: () => void;
}

export function StrategyMenuPanel({
  open,
  anchorRef,
  rotationStrategy,
  onChangeRotationStrategy,
  onClose,
}: StrategyMenuPanelProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    switch (e.key) {
      case "ArrowDown":
        next = (current + 1) % items.length;
        break;
      case "ArrowUp":
        next = (current - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const selected = strategyOptions.findIndex((o) => o.value === rotationStrategy);
    (itemRefs.current[selected] ?? itemRefs.current[0])?.focus();
  }, [open, rotationStrategy]);

  return (
    <FloatingMenu
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      align="right"
      menuRole="listbox"
      ariaLabel="Provider Rotation Strategy"
      testId="strategy-menu-panel"
      className="w-60 bg-[#121218] border border-white/15 rounded-2xl shadow-2xl p-1.5 backdrop-blur-2xl"
    >
      <div onKeyDown={onKeyDown}>
        {strategyOptions.map((option, index) => {
          const selected = option.value === rotationStrategy;
          return (
            <button
              key={option.value}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="option"
              aria-selected={selected}
              data-strategy-value={option.value}
              onClick={() => {
                onChangeRotationStrategy(option.value);
                onClose();
              }}
              className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
                selected ? "bg-white/15 text-white" : "hover:bg-white/5 text-white/75"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium">{option.label}</div>
                <div className="text-[10px] text-white/40 leading-tight">{option.hint}</div>
              </div>
              {selected && <Check className="w-3.5 h-3.5 shrink-0 text-indigo-300" />}
            </button>
          );
        })}
      </div>
    </FloatingMenu>
  );
}

export function RoleAndVmBar({
  activeRoleId,
  onSelectRole,
  rotationStrategy,
  onChangeRotationStrategy,
  providers,
  onOpenSettings,
  onResetVm,
  vmResetting,
  agentCard,
  onOpenAgentCard,
}: RoleAndVmBarProps) {
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [strategyMenuOpen, setStrategyMenuOpen] = useState(false);
  const roleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const strategyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const currentRole = ROLES.find((r) => r.id === activeRoleId) || ROLES[0];
  const currentStrategy =
    strategyOptions.find((option) => option.value === rotationStrategy) || strategyOptions[0];

  return (
    <div className="w-full max-w-4xl mx-auto mb-6 px-3">
      <div className="glass rounded-2xl px-2.5 py-1.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 border border-white/10 shadow-2xl backdrop-blur-xl">
        {/* Left: Active Role Switcher */}
        <button
          ref={roleTriggerRef}
          onClick={() => setRoleMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={roleMenuOpen}
          aria-controls="role-menu-panel"
          data-testid="role-trigger"
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] transition-colors border border-white/10 text-xs font-medium text-white/90"
          title="Switch Agent Role"
        >
          <div
            className="w-5 h-5 rounded-lg grid place-items-center"
            style={{
              background: `hsl(${currentRole.hue} 70% 60% / 0.2)`,
              color: `hsl(${currentRole.hue} 80% 75%)`,
            }}
          >
            <RoleIcon name={currentRole.icon} className="w-3.5 h-3.5" />
          </div>
          <span>Role: <strong className="font-semibold text-white">{currentRole.name}</strong></span>
          <ChevronDown className="w-3.5 h-3.5 text-white/40" />
        </button>

        <RoleMenuPanel
          open={roleMenuOpen}
          anchorRef={roleTriggerRef}
          activeRoleId={activeRoleId}
          onSelectRole={onSelectRole}
          onClose={() => setRoleMenuOpen(false)}
        />

        {/* Left-mid: compact Agent Card strip (click opens the full card) */}
        <button
          onClick={onOpenAgentCard}
          className="group flex min-w-0 items-center gap-2 px-2.5 py-1.5 rounded-xl bg-transparent hover:bg-white/[0.06] text-white/60 hover:text-white border border-transparent hover:border-white/10 text-xs transition-colors"
          title="Open Agent Card — who your agent is and what it works from"
          aria-label="Open Agent Card"
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/[0.06] text-indigo-300">
            <UserRound className="h-3 w-3" />
          </span>
          <span className="max-w-[160px] truncate text-left text-[11px] leading-tight sm:max-w-[220px]">
            <span className="block font-semibold text-white/90">Agent</span>
            <span className="block truncate text-white/40">
              {agentCard.split("\n").map((l) => l.trim()).find(Boolean) ?? "View agent card"}
            </span>
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-white/30 transition-transform group-hover:rotate-180" />
        </button>

        {/* Right: Provider Strategy & Reset Linux VM */}
        <div className="flex items-center gap-2">
          {/* Provider Rotation Strategy: styled custom dropdown */}
          <button
            ref={strategyTriggerRef}
            type="button"
            onClick={() => setStrategyMenuOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={strategyMenuOpen}
            aria-controls="strategy-menu-panel"
            data-testid="strategy-trigger"
            className="flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-[11px] font-mono text-white/80 transition-colors"
            title="Provider Rotation Strategy"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400/80" />
            <span className="text-white/40">Rotation</span>
            <span className="font-semibold text-white/90">{currentStrategy.label}</span>
            <ChevronDown
              className={`w-3.5 h-3.5 text-white/40 transition-transform ${strategyMenuOpen ? "rotate-180" : ""}`}
            />
          </button>

          <StrategyMenuPanel
            open={strategyMenuOpen}
            anchorRef={strategyTriggerRef}
            rotationStrategy={rotationStrategy}
            onChangeRotationStrategy={onChangeRotationStrategy}
            onClose={() => setStrategyMenuOpen(false)}
          />

          {/* Reset / Wipe VM Button: ghost icon + label with confirm tooltip */}
          <button
            onClick={onResetVm}
            disabled={vmResetting}
            className="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-transparent hover:bg-white/[0.06] text-white/60 hover:text-white border border-transparent hover:border-white/10 text-xs transition-colors disabled:opacity-50 disabled:pointer-events-none"
            title="Reset VM? This wipes the Linux machine and cannot be undone."
            aria-label="Reset VM"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${vmResetting ? "animate-spin" : ""}`} />
            <span>{vmResetting ? "Wiping VM…" : "Reset VM"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
