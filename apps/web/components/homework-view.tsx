import type { MyHomework } from "@examio/core";
import { FileList } from "./file-list";
import { Badge, Card, CardHeader } from "./ui";

const when = (d: Date) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/** Homework instructions and the student's submission with feedback (student and parent views). */
export function HomeworkView({ h, children }: { h: MyHomework; children?: React.ReactNode }) {
  const sub = h.submission;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Instructions" description={`${h.subjectName} · due ${when(h.dueAt)}${h.allowLate ? " · late submissions accepted" : ""}`} />
        <div className="space-y-3 p-5 text-sm">
          <p className="whitespace-pre-wrap text-slate-800">{h.instructions ?? "No instructions."}</p>
          <FileList files={h.attachments} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Submission" />
        <div className="space-y-3 p-5 text-sm">
          {sub ? (
            <>
              <p className="flex flex-wrap gap-2">
                <Badge tone={sub.late ? "amber" : "green"}>{sub.late ? "Submitted late" : "Submitted"}</Badge>
                <span className="text-xs text-slate-500">{when(sub.submittedAt)}</span>
              </p>
              {sub.body && <p className="whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-slate-800">{sub.body}</p>}
              <FileList files={sub.files} />
              {sub.feedback && (
                <div className="rounded-md bg-brand-50 px-3 py-2">
                  <p className="text-xs font-semibold text-brand-700">Feedback{sub.returnedAt ? ` · ${when(sub.returnedAt)}` : ""}</p>
                  <p className="whitespace-pre-wrap text-slate-800">{sub.feedback}</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-slate-600">Not submitted yet.</p>
          )}
          {children}
        </div>
      </Card>
    </div>
  );
}
