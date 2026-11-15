"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardHeader, Field, Textarea, cx } from "@/components/ui";
import { commitQuestionImportAction, previewQuestionImportAction, type QuestionImportState } from "../actions";

const SAMPLE = "subject,chapter,topic,type,difficulty,marks,question,option_a,option_b,option_c,option_d,answer,explanation\nMATH,Fractions,Adding fractions,mcq,easy,1,1/2 + 1/2 = ?,1,2,1/4,0,A,Same denominators";

/** Two steps: check the file (nothing saved), then import every row or none. */
export function QuestionImportFlow() {
  const [preview, previewAction] = useActionState<QuestionImportState, FormData>(previewQuestionImportAction, {});
  const [commit, commitAction] = useActionState<QuestionImportState, FormData>(commitQuestionImportAction, {});
  const p = preview.preview;

  if (commit.result) {
    return (
      <Card>
        <CardHeader title={commit.result.replayed ? "Already imported" : `Imported ${commit.result.created} question(s)`} />
        <div className="p-5">
          <Alert tone="green">
            {commit.result.replayed ? "This file was already imported; nothing was added again." : `${commit.result.topicsCreated ? `${commit.result.topicsCreated} chapter(s)/topic(s) created. ` : ""}The questions are in the bank as ${preview.submit ? "in review" : "drafts"}.`}
          </Alert>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="1. Choose the file"
          description="CSV with a header row. Columns: subject (code or name), chapter, topic, type (mcq / tf / descriptive), difficulty, marks, negative_marks, question, option_a … option_f, answer (A-F or true/false), explanation, model_answer. Up to 300 questions."
        />
        <form action={previewAction} className="space-y-4 p-5">
          {preview.message && <Alert>{preview.message}</Alert>}
          <Field label="CSV file" htmlFor="qi-file" hint="Or paste the contents below.">
            <input id="qi-file" name="file" type="file" accept=".csv,text/csv" className="block text-sm" />
          </Field>
          <Field label="Or paste CSV" htmlFor="qi-text">
            <Textarea id="qi-text" name="text" rows={6} defaultValue={preview.text ?? ""} placeholder={SAMPLE} className="font-mono text-xs" />
          </Field>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="createMissing" defaultChecked={preview.createMissing} className="h-5 w-5 rounded border-slate-300" />
            Create missing chapters and topics
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="submit" defaultChecked={preview.submit} className="h-5 w-5 rounded border-slate-300" />
            Submit the questions for review
          </label>
          <SubmitButton variant="secondary" pendingText="Checking…">
            Check file
          </SubmitButton>
        </form>
      </Card>
      {p && (
        <Card>
          <CardHeader title="2. Review" description={p.fileErrors.length ? "The file cannot be imported." : `${p.valid} ready, ${p.invalid} with errors. Nothing has been saved yet.`} />
          <div className="space-y-4 p-5">
            {p.fileErrors.map((e) => (
              <Alert key={e}>{e}</Alert>
            ))}
            {p.willCreate.length > 0 && <p className="text-sm text-slate-700">Will create: {p.willCreate.join(", ")}.</p>}
            {p.ignoredColumns.length > 0 && <p className="text-sm text-slate-600">Ignored columns: {p.ignoredColumns.join(", ")}.</p>}
            {p.rows.length > 0 && (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Import preview">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Rows in the file</caption>
                  <thead>
                    <tr className="text-left text-slate-700">
                      <th scope="col" className="py-2 pr-3">Line</th>
                      <th scope="col" className="py-2 pr-3">Subject / topic</th>
                      <th scope="col" className="py-2 pr-3">Question</th>
                      <th scope="col" className="py-2">Problems</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {p.rows.map((r) => (
                      <tr key={r.line} className={cx(r.errors.length > 0 && "bg-red-50")}>
                        <td className="py-2 pr-3 tabular-nums">{r.line}</td>
                        <td className="py-2 pr-3">
                          {r.subject}
                          {r.path ? ` · ${r.path}` : ""}
                        </td>
                        <td className="py-2 pr-3">{r.stem}</td>
                        <td className="py-2">{r.errors.length ? <span className="text-red-700">{r.errors.join(" ")}</span> : <span className="text-emerald-700">OK</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {commit.message && <Alert>{commit.message}</Alert>}
            {p.invalid === 0 && p.fileErrors.length === 0 && p.rows.length > 0 && (
              <form action={commitAction}>
                <input type="hidden" name="text" value={preview.text ?? ""} />
                <input type="hidden" name="createMissing" value={preview.createMissing ? "1" : "0"} />
                <input type="hidden" name="submit" value={preview.submit ? "1" : "0"} />
                <input type="hidden" name="fingerprint" value={p.fingerprint} />
                <input type="hidden" name="key" value={preview.key ?? ""} />
                <SubmitButton pendingText="Importing…">Import {p.valid} question(s)</SubmitButton>
              </form>
            )}
            {p.invalid > 0 && <p className="text-sm text-slate-600">Fix the rows marked in red, then check the file again. Nothing is imported until every row is valid.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
