"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardHeader, Field, Textarea, cx } from "@/components/ui";
import { commitImportAction, previewImportAction, type ImportState } from "../actions";

const SAMPLE = "name,employee_no,email,phone,role,job_title,joined_on\nAsha Rao,T-101,asha@example.org,,teacher,English teacher,2026-06-01";

/** Two steps: check the file (nothing saved), then import every row or none. */
export function ImportFlow() {
  const [preview, previewAction] = useActionState<ImportState, FormData>(previewImportAction, {});
  const [commit, commitAction] = useActionState<ImportState, FormData>(commitImportAction, {});
  const p = preview.preview;
  const result = commit.result;

  if (result) {
    return (
      <Card>
        <CardHeader title={result.replayed ? "Already imported" : `Imported ${result.created} staff member(s)`} />
        <div className="space-y-4 p-5">
          {result.codes ? (
            <>
              <Alert tone="amber">Give each person their activation code; they choose a password at /redeem. Codes are valid for 48 hours and are not shown again.</Alert>
              <table className="min-w-full text-sm">
                <caption className="sr-only">Activation codes</caption>
                <thead>
                  <tr className="text-left text-slate-700">
                    <th scope="col" className="py-2 pr-4">Employee no.</th>
                    <th scope="col" className="py-2 pr-4">Name</th>
                    <th scope="col" className="py-2">Activation code</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.codes.map((c) => (
                    <tr key={c.employeeNo}>
                      <td className="py-2 pr-4 font-mono text-xs">{c.employeeNo}</td>
                      <td className="py-2 pr-4">{c.name}</td>
                      <td className="py-2 font-mono font-semibold tracking-wider">{c.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <Alert tone="amber">This file was already imported, so nothing was added again. To get new activation codes, open each person on the Staff page.</Alert>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="1. Choose the file" description="CSV with a header row. Columns: name, employee_no, email, phone, role (teacher or finance), job_title, joined_on (YYYY-MM-DD). Up to 300 people." />
        <form action={previewAction} className="space-y-4 p-5">
          {preview.message && <Alert>{preview.message}</Alert>}
          <Field label="CSV file" htmlFor="imp-file" hint="Or paste the contents below.">
            <input id="imp-file" name="file" type="file" accept=".csv,text/csv" className="block text-sm" />
          </Field>
          <Field label="Or paste CSV" htmlFor="imp-text">
            <Textarea id="imp-text" name="text" rows={6} defaultValue={preview.text ?? ""} placeholder={SAMPLE} className="font-mono text-xs" />
          </Field>
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
            {p.rows.length > 0 && (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Import preview">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Rows in the file</caption>
                  <thead>
                    <tr className="text-left text-slate-700">
                      <th scope="col" className="py-2 pr-3">Line</th>
                      <th scope="col" className="py-2 pr-3">Name</th>
                      <th scope="col" className="py-2 pr-3">Employee no.</th>
                      <th scope="col" className="py-2 pr-3">Role</th>
                      <th scope="col" className="py-2">Problems</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {p.rows.map((r) => (
                      <tr key={r.line} className={cx(r.errors.length > 0 && "bg-red-50")}>
                        <td className="py-2 pr-3 tabular-nums">{r.line}</td>
                        <td className="py-2 pr-3">{r.name}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{r.employeeNo}</td>
                        <td className="py-2 pr-3">{r.role}</td>
                        <td className="py-2 text-red-700">{r.errors.join(" ") || <span className="text-emerald-700">OK</span>}</td>
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
                <input type="hidden" name="fingerprint" value={p.fingerprint} />
                <input type="hidden" name="key" value={preview.key ?? ""} />
                <SubmitButton pendingText="Importing…">Import {p.valid} staff member(s)</SubmitButton>
              </form>
            )}
            {p.invalid > 0 && <p className="text-sm text-slate-600">Fix the rows marked in red in your file, then check it again. Nothing is imported until every row is valid.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
