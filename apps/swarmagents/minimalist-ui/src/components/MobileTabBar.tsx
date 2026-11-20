"use client";

import { MonitorPlay, Terminal, Globe, FileText, type LucideIcon } from "lucide-react";

export type ViewId = "desktop" | "terminal" | "browser" | "files";

const TABS: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: "desktop", label: "Desktop", icon: MonitorPlay },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: FileText },
];

/**
 * Mobile-only bottom tab bar for switching the computer screen's inner view
 * (desktop / terminal / browser / files). Telemetry no longer lives here: it
 * is reached from the activity strip above the input bar. Hidden at the `sm`
 * breakpoint (>= 640px) where the in-window tabs are used instead.
 */
export function MobileTabBar({
  activeView,
  onToggleView,
  showDesktop = true,
}: {
  activeView: ViewId;
  onToggleView: (view: ViewId) => void;
  /** False hides the desktop tab (deployment runs with desktop mode off). */
  showDesktop?: boolean;
}) {
  const tabs = showDesktop ? TABS : TABS.filter((tab) => tab.id !== "desktop");
  return (
    <nav
      aria-label="View switcher"
      data-testid="mobile-tab-bar"
      className="fixed inset-x-0 bottom-0 z-30 flex h-[calc(52px+env(safe-area-inset-bottom))] items-stretch justify-around border-t border-white/[0.08] bg-[#0a0a0d]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:hidden"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = activeView === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onToggleView(tab.id)}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center justify-center gap-1 transition-colors ${
              active ? "text-indigo-300" : "text-white/40 hover:text-white/70"
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className="font-mono text-[10px] leading-none">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
