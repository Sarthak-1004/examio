import type { Metadata } from "next";
import Link from "next/link";
import { listMyChildren } from "@examio/core";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "My children" };

export default async function ParentHome() {
  const s = await requireSchoolRole("parent");
  const kids = await listMyChildren(db, s.ctx, s.ctx.schoolId);
  const otherSchools = s.memberships.filter((m) => m.schoolId !== s.ctx.schoolId).length > 0;
  return (
    <>
      <PageHeader
        title={`Hello, ${s.user.fullName.split(" ")[0]}`}
        description="Your children at this school."
        action={
          otherSchools ? (
            <ButtonLink href="/select-school" variant="secondary">
              Switch school
            </ButtonLink>
          ) : undefined
        }
      />
      {kids.length === 0 ? (
        <Card>
          <EmptyState title="No child linked yet">The school links you to your child. If you were given a code for your child, enter it on the Join a school page.</EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {kids.map((k) => (
            <li key={k.studentId}>
              <Card className="p-5">
                <Link href={`/parent/children/${k.studentId}`} className="text-lg font-semibold text-brand-700 hover:underline">
                  {k.displayName}
                </Link>
                <p className="mt-1 text-sm text-slate-700">
                  {k.status === "left" ? <Badge>Left the school</Badge> : k.sectionLabel ? `${k.sectionLabel}${k.rollNo !== null ? ` · Roll ${k.rollNo}` : ""}` : "No class assigned yet"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Admission no. {k.admissionNo}
                  {k.yearName ? ` · ${k.yearName}` : ""}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
