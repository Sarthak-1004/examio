import Link from "next/link";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600 disabled:bg-brand-600/60",
  secondary: "bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-60",
  danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600 disabled:opacity-60",
  ghost: "text-slate-700 hover:bg-slate-100",
};
const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold shadow-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed min-h-11";

export function Button({ variant = "primary", className, ...p }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button className={cx(btnBase, variants[variant], className)} {...p} />;
}

export function ButtonLink({ variant = "primary", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(btnBase, variants[variant], className)} {...p} />;
}

const inputBase =
  "block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-base text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 sm:text-sm";

export function Input({ className, invalid, ...p }: ComponentProps<"input"> & { invalid?: boolean }) {
  return <input className={cx(inputBase, invalid && "ring-red-500", className)} aria-invalid={invalid || undefined} {...p} />;
}

export function Select({ className, invalid, ...p }: ComponentProps<"select"> & { invalid?: boolean }) {
  return <select className={cx(inputBase, "pr-8", invalid && "ring-red-500", className)} aria-invalid={invalid || undefined} {...p} />;
}

export function Textarea({ className, ...p }: ComponentProps<"textarea">) {
  return <textarea className={cx(inputBase, className)} {...p} />;
}

/**
 * Label, control, and hint or error. The control (a single element child) is linked to the hint
 * or error with `aria-describedby` and marked `aria-invalid` when there is an error, so screen
 * readers announce them; callers do not wire this up themselves.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const control =
    isValidElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>(children) && describedBy
      ? cloneElement(children, {
          "aria-describedby": [...new Set([...(children.props["aria-describedby"] ?? "").split(" "), describedBy])].filter(Boolean).join(" "),
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {control}
      {error ? (
        <p className="mt-1.5 text-sm text-red-600" id={errorId}>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-slate-500" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Placeholder block shown while content loads. Decorative: pair it with visible or sr-only loading text. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none", className)} />;
}

/** `min-w-0`: a wide table inside scrolls within the card instead of widening a grid or flex layout. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("min-w-0 rounded-xl bg-white shadow-sm ring-1 ring-slate-200", className)}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const badgeTones = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  slate: "bg-slate-100 text-slate-700 ring-slate-500/20",
  blue: "bg-brand-50 text-brand-700 ring-brand-600/20",
};
export function Badge({ tone = "slate", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset", badgeTones[tone])}>
      {children}
    </span>
  );
}

export function SchoolStatusBadge({ status }: { status: string }) {
  const tone = status === "active" ? "green" : status === "suspended" ? "red" : "amber";
  return <Badge tone={tone}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Alert({ tone = "red", children }: { tone?: "red" | "green" | "amber"; children: ReactNode }) {
  const t = {
    red: "bg-red-50 text-red-800 ring-red-200",
    green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    amber: "bg-amber-50 text-amber-900 ring-amber-200",
  }[tone];
  return (
    <div role={tone === "red" ? "alert" : "status"} className={cx("rounded-lg px-4 py-3 text-sm ring-1", t)}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}
