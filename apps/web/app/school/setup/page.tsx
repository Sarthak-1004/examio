import type { Metadata } from "next";
import Link from "next/link";
import { getSetupChecklist } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Alert, Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "School setup" };

/** Setup overview: what is done and what is left, each step linking to where it is done. */
export default async function SetupOverviewPage() {
  const s = await requireSchoolRole("school_admin");
  const checklist = await getSetupChecklist(db, s.ctx, s.ctx.schoolId);
  const required = checklist.items.filter((i) => i.required);
  return (
    <>
      <PageHeader
        title="School setup"
        description={`${required.filter((i) => i.done).length} of ${required.length} required steps done`}
        action={checklist.ready ? <Badge tone="green">Ready</Badge> : <Badge tone="amber">In progress</Badge>}
      />
      {checklist.ready && (
        <div className="mb-6">
          <Alert tone="green">Setup is complete. Teachers and students can be added next (Staff and Students arrive in the next phases).</Alert>
        </div>
      )}
      <Card>
        <CardHeader title="Checklist" description="Work from top to bottom. Optional steps help later modules but do not block." />
        <ol className="divide-y divide-slate-100">
          {checklist.items.map((item, i) => (
            <li key={item.key} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <span
                aria-hidden
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${item.done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
              >
                {item.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">
                  {item.label}
                  <span className="sr-only">{item.done ? " (done)" : " (to do)"}</span> {!item.required && <Badge>Optional</Badge>}
                </p>
                <p className="text-sm text-slate-600">{item.detail}</p>
              </div>
              <Link href={item.href} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-brand-600 hover:bg-slate-50">
                {item.done ? "Review" : "Set up"}
                <span className="sr-only">: {item.label}</span>
              </Link>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
