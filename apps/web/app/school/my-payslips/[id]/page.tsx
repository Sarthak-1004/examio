import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getMyPayslip } from "@examio/core";
import { PayslipView } from "@/components/payslip";
import { requireSchoolRole } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Payslip" };

/** One of the signed-in staff member's payslips; anyone else's, or a draft, is not found. */
export default async function MyPayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireSchoolRole("school_admin", "teacher", "finance");
  const { id } = await params;
  const p = await getMyPayslip(db, s.ctx, s.ctx.schoolId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  });
  return (
    <>
      <p className="mb-2 text-sm print:hidden">
        <Link href="/school/my-payslips" className="text-brand-600 hover:text-brand-700">
          ← My payslips
        </Link>
      </p>
      <PayslipView p={p} />
    </>
  );
}
