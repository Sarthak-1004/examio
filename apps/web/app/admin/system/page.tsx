import type { Metadata } from "next";
import { getSystemHealth, listJobs, workerStaleSeconds, type CheckStatus, type JobSummary } from "@examio/core";
import { retryJobAction } from "@/app/admin/actions";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { DataTable, type Column } from "@/components/data-table";
import { Badge, Button, Card, CardHeader, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "System" };

const tone: Record<CheckStatus, "green" | "amber" | "red"> = { ok: "green", warning: "amber", critical: "red" };
const label: Record<CheckStatus, string> = { ok: "OK", warning: "Warning", critical: "Critical" };
/** Platform pages belong to no school: times are India time. */
const when = (d: Date) => formatDateTime(d);

const deadColumns: Column<JobSummary>[] = [
  { key: "kind", header: "Job", primary: true, cell: (j) => <span className="font-mono text-xs">{j.kind}</span> },
  { key: "failed", header: "Failed", cell: (j) => (j.finishedAt ? when(j.finishedAt) : "—") },
  { key: "attempts", header: "Attempts", align: "right", secondary: true, cell: (j) => <span className="tabular-nums">{j.attempts}</span> },
  { key: "error", header: "Last error", secondary: true, cell: (j) => <span className="line-clamp-2 break-all text-xs text-slate-600">{j.lastError ?? "—"}</span> },
  {
    key: "retry",
    header: "Action",
    align: "right",
    cell: (j) => (
      <form action={retryJobAction}>
        <input type="hidden" name="jobId" value={j.id} />
        <Button variant="secondary" aria-label={`Retry ${j.kind} job`}>
          Retry
        </Button>
      </form>
    ),
  },
];

/** Operational health for platform administrators: checks, queue, and failed jobs. */
export default async function SystemPage() {
  const s = await requirePlatformAdmin();
  const [health, dead] = await Promise.all([getSystemHealth(db, s.ctx, { staleAfterSeconds: workerStaleSeconds(process.env) }), listJobs(db, s.ctx, "dead", 50)]);

  return (
    <>
      <PageHeader
        title="System"
        description={`Checked ${when(health.checkedAt)} IST`}
        action={<Badge tone={tone[health.status]}>Overall: {label[health.status]}</Badge>}
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="Health checks" description="The worker raises an alert for anything that is not OK." />
          <ul className="divide-y divide-slate-100">
            {health.checks.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <div>
                  <p className="font-medium text-slate-900">{c.label}</p>
                  <p className="text-slate-600">{c.detail}</p>
                </div>
                <Badge tone={tone[c.status]}>{label[c.status]}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Failed jobs" description="Jobs that ran out of attempts or failed permanently. Retrying starts them again with fresh attempts." />
          <DataTable
            caption="Failed jobs"
            columns={deadColumns}
            rows={dead}
            rowKey={(j) => j.id}
            empty={{ title: "No failed jobs", body: "Everything queued has either run or is waiting its turn." }}
          />
        </Card>
      </div>
    </>
  );
}
