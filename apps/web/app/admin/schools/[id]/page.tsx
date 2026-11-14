import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getSchool, listSchoolMembers, listSupportAccess } from "@examio/core";
import { requirePlatformAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { endSupportAccessAction, setSchoolStatusAction } from "@/app/admin/actions";
import { Alert, Badge, Button, Card, CardHeader, PageHeader, SchoolStatusBadge } from "@/components/ui";
import { ResetCodeForm } from "./reset-code-form";
import { SupportAccessForm } from "./support-access-form";

export const metadata: Metadata = { title: "School" };

export default async function SchoolDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const s = await requirePlatformAdmin();
  const { id } = await params;
  const { created } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const school = await getSchool(db, s.ctx, id).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const admins = await listSchoolMembers(db, s.ctx, id, "school_admin");
  const supportHistory = await listSupportAccess(db, s.ctx, id, 5);
  const myOpenGrant = supportHistory.find((g) => g.active && g.platformUserId === s.user.id);
  const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

  const rows: [string, React.ReactNode][] = [
    ["Code", <span className="font-mono">{school.code}</span>],
    ["Board", school.board],
    ["Medium", school.medium],
    ["Time zone", school.timezone],
    ["Address", school.address ?? "—"],
    ["Contact email", school.contactEmail ?? "—"],
    ["Contact phone", school.contactPhone ?? "—"],
    ["Created", school.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" })],
  ];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin" className="text-brand-600 hover:text-brand-700">
          ← Schools
        </Link>
      </p>
      <PageHeader title={school.name} action={<SchoolStatusBadge status={school.status} />} />

      {created && (
        <div className="mb-6">
          <Alert tone="green">
            School created. Share the admin&apos;s sign-in details with them. When setup is ready, mark the school <b>Active</b>.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Profile" />
          <dl className="divide-y divide-slate-100">
            {rows.map(([k, val]) => (
              <div key={k} className="grid grid-cols-3 gap-4 px-5 py-3 text-sm">
                <dt className="text-slate-500">{k}</dt>
                <dd className="col-span-2 text-slate-900">{val}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Status" description="Suspended schools cannot sign in." />
            <div className="flex flex-wrap gap-2 p-5">
              {(["onboarding", "active", "suspended"] as const)
                .filter((st) => st !== school.status)
                .map((st) => (
                  <form key={st} action={setSchoolStatusAction}>
                    <input type="hidden" name="schoolId" value={school.id} />
                    <input type="hidden" name="status" value={st} />
                    <Button variant={st === "suspended" ? "danger" : st === "active" ? "primary" : "secondary"}>
                      {st === "active" ? "Activate" : st === "suspended" ? "Suspend" : "Back to onboarding"}
                    </Button>
                  </form>
                ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="School admins" />
            <ul className="divide-y divide-slate-100">
              {admins.map((a) => (
                <li key={a.userId} className="px-5 py-3 text-sm">
                  <p className="font-medium text-slate-900">
                    {a.fullName} {a.status !== "active" && <Badge tone="red">revoked</Badge>}
                  </p>
                  <p className="text-slate-500">{[a.email, a.phone].filter(Boolean).join(" · ")}</p>
                  {a.status === "active" && <ResetCodeForm userId={a.userId} userName={a.fullName} />}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Support access"
              description="You see only this school's administrators. Open access to help with its other accounts; the school can see when and why."
            />
            <div className="space-y-4 p-5 text-sm">
              {myOpenGrant ? (
                <div className="space-y-3">
                  <Alert tone="amber">
                    Access is open until {when(myOpenGrant.expiresAt)}. Reason: {myOpenGrant.reason}
                  </Alert>
                  <form action={endSupportAccessAction}>
                    <input type="hidden" name="grantId" value={myOpenGrant.id} />
                    <input type="hidden" name="schoolId" value={school.id} />
                    <Button variant="secondary">End access now</Button>
                  </form>
                </div>
              ) : (
                <SupportAccessForm schoolId={school.id} />
              )}
              {supportHistory.length === 0 ? (
                <p className="text-slate-500">No support access has been opened for this school.</p>
              ) : (
                <div>
                  <h3 className="font-medium text-slate-900">Recent access</h3>
                  <ul className="mt-2 space-y-2">
                    {supportHistory.map((g) => (
                      <li key={g.id} className="text-slate-600">
                        <span className="text-slate-900">{when(g.createdAt)}</span> {g.active && <Badge tone="amber">open</Badge>}
                        <br />
                        {g.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
