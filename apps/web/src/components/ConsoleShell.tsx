"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Settings, Keyboard as KeyboardIcon } from "lucide-react";
import Link from "next/link";
import GlassHeader from "@/components/ui/header";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import { toggleShortcuts, useOverlayRequests } from "@/lib/omnibar";

type ConsoleShellProps = {
  children: React.ReactNode;
  missionHint?: string;
  trailing?: React.ReactNode;
  className?: string;
};

export default function ConsoleShell({
  children,
  missionHint,
  trailing,
  className = "",
}: ConsoleShellProps) {
  const pathname = usePathname() || "/";
  const onSettings = pathname.startsWith("/settings");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useOverlayRequests("shortcuts", setShortcutsOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggleShortcuts();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const settingsLink = !onSettings ? (
    <Link
      href="/settings"
      className="inline-flex items-center gap-1 px-2 py-1 rounded-r-sm text-fg-3 text-meta hover:text-fg-1 hover:bg-white/[0.04] transition-colors duration-fast ease-out"
    >
      <Settings className="w-3.5 h-3.5" />
      <span className="hidden md:inline">Settings</span>
    </Link>
  ) : null;

  const shortcutsBtn = (
    <button
      type="button"
      onClick={toggleShortcuts}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-r-sm text-fg-3 text-meta hover:text-fg-1 hover:bg-white/[0.04] transition-colors duration-fast ease-out"
      title="Keyboard Shortcuts (?)"
      aria-label="Keyboard shortcuts"
    >
      <KeyboardIcon className="w-3.5 h-3.5" />
      <span className="hidden md:inline font-mono text-micro">?</span>
    </button>
  );

  return (
    <div className={`relative min-h-[100svh] flex flex-col bg-bg-0 text-fg-1 font-sans overflow-hidden ${className}`}>
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <GlassHeader
        missionHint={missionHint}
        trailing={
          <>
            {shortcutsBtn}
            {settingsLink}
            {trailing}
          </>
        }
      />
      <div className="relative z-10 flex flex-col flex-1 min-h-0">
        {children}
      </div>
    </div>
  );
}
