import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getPayslip } from "@examio/core";
import { PayslipView } from "@/components/payslip";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Payslip" };

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "finance");
  const { id } = await params;
  const p = await getPayslip(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href={`/school/payroll/runs/${p.runId}`} className="text-brand-600 hover:text-brand-700">
          ← Payroll run
        </Link>
      </p>
      <PayslipView p={p} />
    </>
  );
}
