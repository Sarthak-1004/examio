import { formatPaise, type Payslip } from "@examio/core";
import { PrintButton } from "./print-button";
import { Badge, Card } from "./ui";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ""} ${m.slice(0, 4)}`;

/** A printable payslip (administrators, finance and, from Phase 14.5, the staff member). */
export function PayslipView({ p }: { p: Payslip }) {
  const earnings = p.lines.filter((l) => l.kind === "earning");
  const deductions = p.lines.filter((l) => l.kind === "deduction");
  const row = (label: string, paise: number, strong = false) => (
    <div key={label} className={`flex justify-between gap-4 py-1 ${strong ? "border-t border-slate-200 pt-2 font-semibold" : ""}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{formatPaise(paise)}</dd>
    </div>
  );
  return (
    <Card className="p-6 print:shadow-none print:ring-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <p className="text-sm text-slate-500">{p.schoolName}</p>
          <h2 className="text-xl font-semibold text-slate-900">{`Payslip for ${monthName(p.month)}`}</h2>
          <p className="text-sm text-slate-600">{`${p.periodStart} to ${p.periodEnd}`}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {p.runStatus === "draft" ? <Badge tone="amber">Draft, not approved</Badge> : p.payment ? <Badge tone="green">{`Paid ${p.payment.paidOn}`}</Badge> : <Badge tone="blue">Approved, not yet paid</Badge>}
          <PrintButton />
        </div>
      </div>
      <dl className="grid gap-x-8 gap-y-2 border-b border-slate-200 py-4 text-sm sm:grid-cols-2">
        {[
          ["Name", p.staffName],
          ["Employee no.", p.employeeNo],
          ["Designation", p.designation ?? "—"],
          ["Department", p.department ?? "—"],
          ["Working days", p.workingDays],
          ["Loss-of-pay days", p.lopDays],
          ["Payable days", p.payableDays],
          ["Paid into", p.accountLast4 ? `Account ending ${p.accountLast4}` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-medium text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-8 py-4 text-sm sm:grid-cols-2">
        <div>
          <h3 className="mb-2 font-semibold text-slate-900">Earnings</h3>
          <dl>
            {row(`Basic (${formatPaise(p.basicPaise)} a month)`, p.earnedBasicPaise)}
            {earnings.map((l) => row(l.name, l.amountPaise))}
            {row("Gross earnings", p.grossPaise, true)}
          </dl>
        </div>
        <div>
          <h3 className="mb-2 font-semibold text-slate-900">Deductions</h3>
          <dl>
            {deductions.length === 0 ? <p className="py-1 text-slate-600">None</p> : deductions.map((l) => row(l.name, l.amountPaise))}
            {row("Total deductions", p.deductionsPaise, true)}
          </dl>
        </div>
      </div>
      <div className="flex justify-between border-t border-slate-200 pt-4 text-lg font-bold text-slate-900">
        <span>Net pay</span>
        <span className="tabular-nums">{formatPaise(p.netPaise)}</span>
      </div>
      {p.payment && <p className="mt-2 text-sm text-slate-600">{`Paid on ${p.payment.paidOn}, reference ${p.payment.reference}.`}</p>}
      <p className="mt-4 text-xs text-slate-500">Computer-generated payslip. Deductions are those set by the school; Examio does not calculate statutory amounts.</p>
    </Card>
  );
}
