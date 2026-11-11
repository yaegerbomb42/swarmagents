"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ensureAuthListener, getStoredUser, getToken, logout, type AuthUser } from "@/lib/auth";
import ConsoleNav, { isConsolePath } from "@/components/ConsoleNav";
import Wordmark from "@/components/brand/Wordmark";

interface SiteHeaderProps {
  subtitle?: string;
}

export default function SiteHeader({ subtitle }: SiteHeaderProps) {
  const pathname = usePathname();
  const onConsole = isConsolePath(pathname);
  const onAuth = pathname.startsWith("/login") || pathname.startsWith("/signup");
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    ensureAuthListener();
    if (getToken()) setUser(getStoredUser());
    else setUser(null);
  }, [pathname]);

  return (
    <header className="border-b border-line-1 bg-bg-0/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1800px] items-center justify-between px-5 py-4 lg:px-8">
        <Wordmark size={24} />

        <nav className="flex items-center gap-3">
          {!onAuth && <ConsoleNav />}
          {user ? (
            <>
              <Link
                href="/settings"
                className="tactile hidden text-sm text-fg-2 hover:text-fg-1 sm:inline px-2 py-1 rounded-md"
              >
                Settings
              </Link>
              <span className="hidden text-meta text-fg-3 sm:inline max-w-[140px] truncate">
                {user.display_name || user.email}
              </span>
              <button
                type="button"
                onClick={() => logout()}
                className="tactile text-sm text-white/50 hover:text-white px-2 py-1 rounded-md"
              >
                Sign out
              </button>
              {onConsole ? (
                <Link href="/" className="tactile text-sm text-white/50 hover:text-white px-2 py-1 rounded-md">
                  Home
                </Link>
              ) : (
                <Link
                  href="/decomp"
                  className="group tactile-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm normal-case tracking-normal"
                >
                  Open Console
                  <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
                </Link>
              )}
            </>
          ) : (
            <>
              {!onAuth && (
                <Link href="/login" className="tactile text-sm text-white/50 hover:text-white px-2 py-1 rounded-md">
                  Sign in
                </Link>
              )}
              <Link
                href={pathname.startsWith("/signup") ? "/login" : "/signup"}
                className="group tactile-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm normal-case tracking-normal"
              >
                {pathname.startsWith("/signup")
                  ? "Sign in"
                  : pathname.startsWith("/login")
                    ? "Create account"
                    : "Get started"}
                <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
