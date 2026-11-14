"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const TABS = [
  { href: "/school/setup", label: "Overview" },
  { href: "/school/setup/profile", label: "Profile" },
  { href: "/school/setup/years", label: "Academic years" },
  { href: "/school/setup/classes", label: "Classes & sections" },
  { href: "/school/setup/subjects", label: "Subjects" },
  { href: "/school/setup/grading", label: "Grading" },
  { href: "/school/setup/calendar", label: "Calendar & attendance" },
];

/** Section navigation for school setup; scrolls sideways on small screens. */
export function SetupNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="School setup" className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-slate-200">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium",
                  active ? "border-brand-600 text-brand-700" : "border-transparent text-slate-600 hover:text-slate-900",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
