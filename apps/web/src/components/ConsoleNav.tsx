"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Menu, X } from "lucide-react";

export const CONSOLE_TABS = [
  { href: "/decomp", label: "Console", match: (p: string) => p === "/decomp" || p.startsWith("/decomp/orchestrator") || p === "/" },
  { href: "/live", label: "Sandboxes", match: (p: string) => p.startsWith("/live") },
  { href: "/settings", label: "Providers & Models", match: (p: string) => p.startsWith("/settings") },
] as const;

export function isConsolePath(pathname: string): boolean {
  return (
    pathname.startsWith("/decomp") ||
    pathname.startsWith("/live") ||
    pathname.startsWith("/memory") ||
    pathname.startsWith("/lab") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/chat") ||
    pathname.startsWith("/billing") ||
    pathname.startsWith("/datasets") ||
    pathname.startsWith("/dataset")
  );
}

function NavLink({
  tab,
  active,
  dense,
  onNavigate,
}: {
  tab: (typeof CONSOLE_TABS)[number];
  active: boolean;
  dense: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={tab.href}
      onClick={onNavigate}
      className={`relative block w-full ${
        dense ? "px-3 py-2.5 text-sm" : "px-2.5 py-1 text-sm"
      } rounded-r-sm whitespace-nowrap transition-colors duration-fast ease-out ${
        active ? "text-fg-1 font-medium bg-bg-3 shadow-[inset_0_0_0_1px_var(--line-2)]" : "text-fg-3 hover:text-fg-1"
      }`}
      aria-current={active ? "page" : undefined}
    >
      {tab.label}
    </Link>
  );
}

export default function ConsoleNav({ dense = false }: { dense?: boolean }) {
  const pathname = usePathname() || "/";
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    closeDrawer();
  }, [pathname, closeDrawer]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [drawerOpen, closeDrawer]);

  return (
    <>
      {/* Desktop / tablet inline nav */}
      <nav
        className={`hidden md:flex items-center gap-0.5 overflow-x-auto scrollbar-none ${
          dense ? "max-w-[min(100%,42rem)]" : ""
        } rounded-r-md px-1 py-0.5 bg-bg-2 border border-line-1`}
        aria-label="Console"
      >
        {CONSOLE_TABS.map((tab) => (
          <NavLink key={tab.href} tab={tab} active={tab.match(pathname)} dense={dense} />
        ))}
      </nav>

      {/* Mobile hamburger trigger */}
      <button
        type="button"
        className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-white/10 bg-white/[0.04] text-zinc-300 hover:text-zinc-100 hover:bg-white/[0.08] transition-colors"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={drawerOpen}
      >
        <Menu size={18} />
      </button>

      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Console navigation">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            onClick={closeDrawer}
            aria-label="Close navigation menu"
          />
          <aside
            className="absolute top-0 left-0 h-full w-[min(18rem,85vw)] flex flex-col shadow-e2 bg-bg-1 border-r border-line-2"
          >
            <div className="flex items-center justify-between px-4 h-12 border-b border-white/10">
              <span className="text-micro uppercase text-fg-3">Console</span>
              <button
                type="button"
                onClick={closeDrawer}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-3" aria-label="Console mobile">
              {CONSOLE_TABS.map((tab) => (
                <NavLink
                  key={tab.href}
                  tab={tab}
                  active={tab.match(pathname)}
                  dense={dense}
                  onNavigate={closeDrawer}
                />
              ))}
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
