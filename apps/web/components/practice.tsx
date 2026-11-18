import Link from "next/link";
import { formatBp, formatMarks, type FamilyPracticeRow, type PracticeAttemptView, type PracticeProgress } from "@examio/core";
import { Badge, EmptyState } from "./ui";
import { formatDateTime } from "@/lib/format";


/** Window and attempt status of an assigned practice set. */
export function practiceStatus(r: FamilyPracticeRow, timeZone: string): { label: string; tone: "green" | "amber" | "slate" | "blue" } {
  if (r.inProgressAttemptId) return { label: "In progress", tone: "blue" };
  if (r.open) return r.attemptLimit !== null && r.attemptsUsed >= r.attemptLimit ? { label: "All attempts used", tone: "slate" } : { label: "Open", tone: "green" };
  if (r.opensAt && new Date(r.opensAt).getTime() > Date.now()) return { label: `Opens ${formatDateTime(r.opensAt, timeZone)}`, tone: "amber" };
  return { label: "Closed", tone: "slate" };
}

/** Assigned practice for a student (with actions) or a parent (read-only). */
export function PracticeList({ rows, action, attemptHref, empty, timeZone }: { timeZone: string; rows: FamilyPracticeRow[]; action?: (r: FamilyPracticeRow) => React.ReactNode; attemptHref: (attemptId: string) => string; empty: string }) {
  if (rows.length === 0) return <EmptyState title="No practice yet">{empty}</EmptyState>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => {
        const st = practiceStatus(r, timeZone);
        return (
          <li key={r.setId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-slate-900">
                {r.title} <Badge tone={st.tone}>{st.label}</Badge>
              </p>
              <p className="text-slate-600">
                {r.subjectName}
                {r.topicPath ? ` · ${r.topicPath}` : ""} · {r.itemCount} question{r.itemCount === 1 ? "" : "s"}
                {r.closesAt ? ` · closes ${formatDateTime(r.closesAt, timeZone)}` : ""}
              </p>
              <p className="text-xs text-slate-500">
                Attempts: {r.attemptsUsed}
                {r.attemptLimit !== null ? ` of ${r.attemptLimit}` : ""}
                {r.bestBp !== null ? ` · best ${formatBp(r.bestBp)}` : ""}
                {r.feedback === "after_close" ? " · answers shown after it closes" : ""}
                {r.lastAttemptId && (
                  <>
                    {" · "}
                    <Link href={attemptHref(r.lastAttemptId)} className="text-brand-700 hover:underline">
                      Latest attempt
                    </Link>
                  </>
                )}
              </p>
            </div>
            {action?.(r)}
          </li>
        );
      })}
    </ul>
  );
}

function responseText(item: PracticeAttemptView["items"][number]): string {
  const r = item.answer?.response as { choice?: string | null; value?: boolean | null; text?: string } | undefined;
  if (!r) return "Not answered";
  if (item.type === "single_choice") return r.choice ? `${r.choice.toUpperCase()}. ${item.options?.find((o) => o.id === r.choice)?.text ?? ""}` : "Not answered";
  if (item.type === "true_false") return r.value === true ? "True" : r.value === false ? "False" : "Not answered";
  return r.text?.trim() ? r.text : "Not answered";
}

function keyText(item: PracticeAttemptView["items"][number]): string {
  const k = item.result?.answerKey as { correct?: string | boolean; modelAnswer?: string | null } | undefined;
  if (!k) return "";
  if (item.type === "single_choice") return `${String(k.correct).toUpperCase()}. ${item.options?.find((o) => o.id === k.correct)?.text ?? ""}`;
  if (item.type === "true_false") return k.correct ? "True" : "False";
  return k.modelAnswer ?? "No model answer.";
}

/** A submitted (or read-only) attempt: answers, and results with keys once feedback is released. */
export function AttemptReview({ v, timeZone }: { v: PracticeAttemptView; timeZone: string }) {
  return (
    <div className="space-y-4">
      {v.status === "submitted" && !v.released && (
        <p role="status" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Submitted. Answers and your score are shown after the practice closes{v.closesAt ? ` (${formatDateTime(v.closesAt, timeZone)})` : ""}.
        </p>
      )}
      {v.score && (
        <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-800">
          Score: <span className="font-semibold">{formatMarks(v.score.scoreX100)}</span> of {formatMarks(v.score.maxX100)} · {v.score.correct} of {v.score.scored} correct
          {v.items.some((i) => i.type === "descriptive") ? " · written answers are not scored in practice" : ""}. Practice does not count towards results.
        </p>
      )}
      <ol className="space-y-4">
        {v.items.map((i) => (
          <li key={i.itemId} className="rounded-lg border border-slate-200 p-4 text-sm">
            <p className="mb-2 flex flex-wrap items-center gap-2 font-medium text-slate-900">
              <span>Question {i.position}</span>
              {i.result && i.result.isCorrect === true && <Badge tone="green">Correct</Badge>}
              {i.result && i.result.isCorrect === false && <Badge tone="red">{i.answer ? "Incorrect" : "Not answered"}</Badge>}
              {i.result && i.result.scoreX100 !== null && <span className="text-xs font-normal text-slate-500">{formatMarks(i.result.scoreX100)} mark(s)</span>}
            </p>
            <p className="whitespace-pre-wrap text-slate-900">{i.stem}</p>
            {i.imageFileId && <img src={`/files/${i.imageFileId}`} alt={`Figure for question ${i.position}`} className="mt-2 max-h-64 rounded border border-slate-200" />}
            <p className="mt-2 text-slate-700">
              <span className="font-semibold">Answer given: </span>
              <span className="whitespace-pre-wrap">{responseText(i)}</span>
            </p>
            {i.result && (
              <div className="mt-2 space-y-1 rounded-md bg-slate-50 px-3 py-2 text-slate-700">
                <p>
                  <span className="font-semibold">{i.type === "descriptive" ? "Model answer: " : "Correct answer: "}</span>
                  <span className="whitespace-pre-wrap">{keyText(i)}</span>
                </p>
                {i.result.explanation && <p className="whitespace-pre-wrap">{i.result.explanation}</p>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const STANDING = { weak: { label: "Needs practice", tone: "red" }, ok: { label: "Doing well", tone: "green" }, too_few: { label: "Not enough practice yet", tone: "slate" } } as const;

/** Accuracy per chapter/topic and recent attempts. */
export function PracticeProgressView({ p, attemptHref, timeZone }: { p: PracticeProgress; attemptHref: (attemptId: string) => string; timeZone: string }) {
  return (
    <div className="space-y-6">
      {p.topics.length === 0 ? (
        <EmptyState title="No progress yet">Progress appears once practice has been submitted and its answers are shown.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Accuracy by chapter and topic</caption>
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-2">Chapter / topic</th>
                <th scope="col" className="px-5 py-2">Answered</th>
                <th scope="col" className="px-5 py-2">Correct</th>
                <th scope="col" className="px-5 py-2">Standing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.topics.map((t) => (
                <tr key={t.topicId ?? "none"}>
                  <th scope="row" className="px-5 py-2 text-left font-medium text-slate-900">{t.topicPath}</th>
                  <td className="px-5 py-2 tabular-nums">{t.answered}</td>
                  <td className="px-5 py-2 tabular-nums">{formatBp(t.accuracyBp)}</td>
                  <td className="px-5 py-2">
                    <Badge tone={STANDING[t.standing].tone}>{STANDING[t.standing].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-5 py-3 text-xs text-slate-500">A topic needs practice below 60% correct once at least 5 questions have been answered. Written answers are not counted.</p>
        </div>
      )}
      {p.attempts.length > 0 && (
        <div>
          <h3 className="px-5 pb-2 text-sm font-semibold text-slate-900">Recent attempts</h3>
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {p.attempts.map((a) => (
              <li key={a.attemptId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span>
                  <Link href={attemptHref(a.attemptId)} className="text-brand-700 hover:underline">
                    {a.title}
                  </Link>{" "}
                  <span className="text-slate-500">· attempt {a.attemptNo}{a.subjectName ? ` · ${a.subjectName}` : ""}</span>
                </span>
                <span className="text-slate-700">{a.status === "in_progress" ? "In progress" : a.scoreBp !== null ? formatBp(a.scoreBp) : `Submitted ${a.submittedAt ? formatDateTime(a.submittedAt, timeZone) : ""}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
