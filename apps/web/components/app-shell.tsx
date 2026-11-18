"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { logoutAction } from "@/app/actions/auth";
import { cx } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  /** Exact match only (for index routes like /admin). */
  exact?: boolean;
  soon?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Page frame for signed-in areas. Accessibility:
 * - a "Skip to main content" link is the first tab stop;
 * - on small screens the navigation is a modal drawer: focus moves into it, Tab stays inside,
 *   Escape or the close button closes it, and focus returns to the menu button;
 * - the drawer closes on navigation and the page behind it does not scroll.
 */
export function AppShell({
  nav,
  title,
  subtitle,
  userName,
  userDetail,
  children,
}: {
  nav: NavItem[];
  title: string;
  subtitle?: string;
  userName: string;
  userDetail?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const isActive = (n: NavItem) => (n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + "/"));

  const close = useCallback(() => {
    setOpen(false);
    menuButton.current?.focus();
  }, []);

  // Close the drawer after navigating.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const panel = drawer.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  const sidebar = (inDrawer: boolean) => (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-start justify-between px-5 pb-4 pt-5">
        <div className="min-w-0">
          <Link href="/" className="text-xl font-extrabold tracking-tight text-white">
            examio
          </Link>
          <p className="mt-3 truncate text-sm font-medium text-white">{title}</p>
          {subtitle && <p className="truncate text-xs text-brand-100/80">{subtitle}</p>}
        </div>
        {inDrawer && (
          <button onClick={close} className="-mr-2 rounded-md p-2 text-white hover:bg-white/10" aria-label="Close menu">
            <svg className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
        {nav.map((n) =>
          n.soon ? (
            <span key={n.href} aria-disabled="true" className="flex min-h-11 items-center justify-between rounded-lg px-3 text-sm text-brand-100/60">
              {n.label}
              <span className="text-[10px] uppercase tracking-wide">
                soon<span className="sr-only"> (not available yet)</span>
              </span>
            </span>
          ) : (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n) ? "page" : undefined}
              className={cx(
                "flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition",
                isActive(n) ? "bg-white/15 text-white" : "text-brand-100 hover:bg-white/10 hover:text-white",
              )}
            >
              {n.label}
            </Link>
          ),
        )}
      </nav>
      <div className="shrink-0 border-t border-white/10 p-4">
        <p className="truncate text-sm font-medium text-white">{userName}</p>
        {userDetail && <p className="truncate text-xs text-brand-100/80">{userDetail}</p>}
        <div className="mt-3 flex flex-wrap gap-1">
          {(
            [
              ["/change-password", "Change password"],
              ["/join", "Join a school"],
              ["/mfa/setup", "Two-step sign-in"],
            ] as const
          ).map(([href, label]) => (
            <Link key={href} href={href} className="inline-flex min-h-9 items-center rounded-md px-2 text-xs text-brand-100 hover:bg-white/10">
              {label}
            </Link>
          ))}
          <form action={logoutAction}>
            <button className="inline-flex min-h-9 items-center rounded-md px-2 text-xs text-brand-100 hover:bg-white/10">Sign out</button>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-sm font-semibold text-brand-700 shadow focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 bg-brand-900 lg:block">{sidebar(false)}</aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-30 flex items-center justify-between bg-brand-900 px-4 py-2 lg:hidden">
        <Link href="/" className="text-lg font-extrabold tracking-tight text-white">
          examio
        </Link>
        <button
          ref={menuButton}
          onClick={() => setOpen(true)}
          className="rounded-md p-2.5 text-white hover:bg-white/10"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="mobile-menu"
        >
          <svg className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu" id="mobile-menu">
          <div className="absolute inset-0 bg-slate-900/50" onClick={close} aria-hidden />
          <div
            ref={drawer}
            className="absolute inset-y-0 left-0 w-72 max-w-[85%] overflow-y-auto bg-brand-900 shadow-xl"
            // Following any link closes the drawer, even one to the page already open.
            onClick={(e) => {
              if (e.target instanceof Element && e.target.closest("a")) setOpen(false);
            }}
          >
            {sidebar(true)}
          </div>
        </div>
      )}

      <main id="main" tabIndex={-1} className="outline-none lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">{children}</div>
      </main>
    </div>
  );
}
