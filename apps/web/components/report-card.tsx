import Link from "next/link";
import { formatMarks, type ReportCard } from "@examio/core";
import { PrintButton } from "./print-button";
import { Badge, Card, CardHeader, EmptyState } from "./ui";

const pct = (bp: number | null) => (bp === null ? "—" : `${(bp / 100).toFixed(2)}%`);
const score = (i: ReportCard["subjects"][number]["items"][number]) =>
  i.status === "absent" ? "Absent" : i.status === "exempt" ? "Exempt" : `${formatMarks(i.scoreX100 ?? 0)} / ${formatMarks(i.maxX100)}`;

/**
 * A student's report card for one academic year: every released online exam and paper exam by
 * subject, subject totals and the overall result. Provisional format (equal weight by marks;
 * absent counts as zero, exempt is left out; no ranking). Printable.
 */
export function ReportCardView({ card, basePath, examHref }: { card: ReportCard; basePath: string; examHref?: (examId: string) => string }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        {card.years.length > 1 ? (
          <nav aria-label="Academic year" className="flex flex-wrap gap-2">
            {card.years.map((y) => (
              <Link
                key={y.id}
                href={`${basePath}?year=${y.id}`}
                aria-current={y.id === card.year.id ? "page" : undefined}
                className={`inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-inset ${y.id === card.year.id ? "bg-brand-50 text-brand-800 ring-brand-300" : "text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
              >
                {y.name}
              </Link>
            ))}
          </nav>
        ) : (
          <span />
        )}
        <PrintButton />
      </div>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div>
            <p className="text-lg font-semibold text-slate-900">{card.student.name}</p>
            <p className="text-sm text-slate-600">
              Admission no. {card.student.admissionNo}
              {card.student.className ? ` · ${card.student.className}` : ""}
              {card.year.name ? ` · ${card.year.name}` : ""}
            </p>
          </div>
          {card.overall.maxX100 > 0 && (
            <div className="text-right">
              <p className="text-sm text-slate-500">Overall</p>
              <p className="text-2xl font-bold tabular-nums text-slate-900">{pct(card.overall.percentBp)}</p>
              {card.overall.grade && (
                <Badge tone={card.overall.passed ? "green" : "red"}>
                  Grade {card.overall.grade}
                  {card.overall.passed === false ? " · below pass mark" : ""}
                </Badge>
              )}
            </div>
          )}
        </div>
      </Card>
      {card.subjects.length === 0 ? (
        <Card>
          <EmptyState title="No results yet">Results appear here once the school releases them.</EmptyState>
        </Card>
      ) : (
        card.subjects.map((sub) => (
          <Card key={sub.subjectId}>
            <CardHeader
              title={sub.subjectName}
              description={sub.maxX100 > 0 ? `${formatMarks(sub.scoreX100)} / ${formatMarks(sub.maxX100)} · ${pct(sub.percentBp)}${sub.grade ? ` · grade ${sub.grade}` : ""}` : "Exempt from every assessment"}
            />
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">{sub.subjectName} assessments</caption>
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-2">Assessment</th>
                    <th scope="col" className="px-5 py-2">Marks</th>
                    <th scope="col" className="px-5 py-2">Percent</th>
                    <th scope="col" className="px-5 py-2">Grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sub.items.map((i) => (
                    <tr key={`${i.kind}-${i.id}`}>
                      <th scope="row" className="px-5 py-2 text-left font-normal text-slate-900">
                        {i.kind === "exam" && examHref && i.status === "present" ? (
                          <Link href={examHref(i.id)} className="text-brand-700 hover:underline">
                            {i.title}
                          </Link>
                        ) : (
                          i.title
                        )}
                        <span className="block text-xs text-slate-500">
                          {i.kind === "exam" ? "Online exam" : "Paper exam"}
                          {i.date ? ` · ${i.date}` : ""}
                          {i.corrected ? " · corrected" : ""}
                        </span>
                      </th>
                      <td className="px-5 py-2 tabular-nums">{score(i)}</td>
                      <td className="px-5 py-2 tabular-nums">{pct(i.percentBp)}</td>
                      <td className="px-5 py-2">{i.grade ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
      <p className="text-xs text-slate-500">
        Totals count every released assessment by its marks. Absent counts as zero; exempt is left out.
        {card.scheme ? ` Grades: ${card.scheme.name}, pass mark ${(card.scheme.passBp / 100).toFixed(2).replace(/\.?0+$/, "")}%.` : ""} Practice is not included.
      </p>
    </div>
  );
}
