"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardHeader, Field, Select, Textarea, cx } from "@/components/ui";
import { commitStudentImportAction, previewStudentImportAction, type StudentImportState } from "../actions";

const SAMPLE = "name,admission_no,date_of_birth,class,section,roll_no\nAarav Mehta,2026/001,2014-05-10,Class 7,A,1";
const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  admission_no: "Admission number",
  admitted_on: "Admission date",
  date_of_birth: "Date of birth",
  class: "Class",
  section: "Section",
  roll_no: "Roll number",
};

/** Two steps: check the file (nothing saved), then import every row or none. */
export function StudentImportFlow({ years }: { years: { id: string; name: string; current: boolean }[] }) {
  const [preview, previewAction] = useActionState<StudentImportState, FormData>(previewStudentImportAction, {});
  const [commit, commitAction] = useActionState<StudentImportState, FormData>(commitStudentImportAction, {});
  const p = preview.preview;
  const result = commit.result;

  if (result) {
    return (
      <Card>
        <CardHeader title={result.replayed ? "Already imported" : `Imported ${result.created} student(s)`} description={result.replayed ? undefined : `${result.enrolled} enrolled in a section.`} />
        <div className="space-y-4 p-5">
          {result.codes ? (
            <>
              <Alert tone="amber">Give each student (or their parent) the sign-in name and activation code; they choose a password at /redeem. Codes are valid for 48 hours and are not shown again: print or copy this list now.</Alert>
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Activation codes list">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Activation codes</caption>
                  <thead>
                    <tr className="text-left text-slate-700">
                      <th scope="col" className="py-2 pr-4">Admission no.</th>
                      <th scope="col" className="py-2 pr-4">Name</th>
                      <th scope="col" className="py-2 pr-4">Sign-in name</th>
                      <th scope="col" className="py-2">Activation code</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.codes.map((c) => (
                      <tr key={c.admissionNo}>
                        <td className="py-2 pr-4 font-mono text-xs">{c.admissionNo}</td>
                        <td className="py-2 pr-4">{c.name}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{c.username}</td>
                        <td className="py-2 font-mono font-semibold tracking-wider">{c.code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <Alert tone="amber">This file was already imported, so nothing was added again. To get new activation codes, open each student&apos;s page.</Alert>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="1. Choose the file"
          description="CSV with a header row. Recognised columns (common spellings work): name, admission number, admission date, date of birth (YYYY-MM-DD), class, section, roll number. Up to 300 students per file: import class by class."
        />
        <form action={previewAction} className="space-y-4 p-5">
          {preview.message && <Alert>{preview.message}</Alert>}
          <Field label="Academic year" htmlFor="si-year" hint="Class and section are looked up in this year.">
            <Select id="si-year" name="yearId" defaultValue={p?.yearId ?? years.find((y) => y.current)?.id ?? years[0]?.id}>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="CSV file" htmlFor="si-file" hint="Or paste the contents below.">
            <input id="si-file" name="file" type="file" accept=".csv,text/csv" className="block text-sm" />
          </Field>
          <Field label="Or paste CSV" htmlFor="si-text">
            <Textarea id="si-text" name="text" rows={6} defaultValue={preview.text ?? ""} placeholder={SAMPLE} className="font-mono text-xs" />
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
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" aria-label="Column mapping">
              {p.mapping.map((m) => (
                <div key={m.field} className="flex justify-between gap-2 border-b border-slate-100 py-1">
                  <dt className="text-slate-600">{FIELD_LABEL[m.field] ?? m.field}</dt>
                  <dd className={cx("font-medium", m.column ? "text-slate-900" : "text-slate-400")}>{m.column ?? "not in file"}</dd>
                </div>
              ))}
            </dl>
            {p.ignoredColumns.length > 0 && <p className="text-sm text-slate-600">Ignored columns: {p.ignoredColumns.join(", ")}.</p>}
            {p.rows.length > 0 && (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Import preview">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Rows in the file</caption>
                  <thead>
                    <tr className="text-left text-slate-700">
                      <th scope="col" className="py-2 pr-3">Line</th>
                      <th scope="col" className="py-2 pr-3">Name</th>
                      <th scope="col" className="py-2 pr-3">Admission no.</th>
                      <th scope="col" className="py-2 pr-3">Class</th>
                      <th scope="col" className="py-2 pr-3">Roll</th>
                      <th scope="col" className="py-2">Problems</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {p.rows.map((r) => (
                      <tr key={r.line} className={cx(r.errors.length > 0 ? "bg-red-50" : r.warnings.length > 0 && "bg-amber-50")}>
                        <td className="py-2 pr-3 tabular-nums">{r.line}</td>
                        <td className="py-2 pr-3">{r.name}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{r.admissionNo}</td>
                        <td className="py-2 pr-3">{r.className ? `${r.className} ${r.sectionName}` : "—"}</td>
                        <td className="py-2 pr-3 tabular-nums">{r.rollNo ?? "—"}</td>
                        <td className="py-2">
                          {r.errors.length > 0 && <span className="text-red-700">{r.errors.join(" ")} </span>}
                          {r.warnings.length > 0 && <span className="text-amber-800">{r.warnings.join(" ")}</span>}
                          {r.errors.length === 0 && r.warnings.length === 0 && <span className="text-emerald-700">OK</span>}
                        </td>
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
                <input type="hidden" name="yearId" value={p.yearId} />
                <input type="hidden" name="fingerprint" value={p.fingerprint} />
                <input type="hidden" name="key" value={preview.key ?? ""} />
                <SubmitButton pendingText="Importing…">Import {p.valid} student(s)</SubmitButton>
              </form>
            )}
            {p.invalid > 0 && <p className="text-sm text-slate-600">Fix the rows marked in red in your file, then check it again. Nothing is imported until every row is valid. Rows marked in amber are warnings only.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
