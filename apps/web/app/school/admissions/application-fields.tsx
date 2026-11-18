import { Field, Input, Select, Textarea } from "@/components/ui";

export const ADMISSION_STATUS: Record<string, { label: string; tone: "slate" | "blue" | "amber" | "green" | "red" }> = {
  enquiry: { label: "Enquiry", tone: "slate" },
  applied: { label: "Applied", tone: "blue" },
  under_review: { label: "Under review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  withdrawn: { label: "Withdrawn", tone: "slate" },
  enrolled: { label: "Enrolled", tone: "green" },
};

/** Applicant, guardian and the year and class applied for. */
export function ApplicationFields({
  years,
  classes,
  d,
}: {
  years: { id: string; name: string }[];
  classes: { id: string; name: string }[];
  d?: { yearId: string; classId: string; applicantName: string; dateOfBirth: string | null; guardianName: string; guardianPhone: string | null; guardianEmail: string | null; previousSchool: string | null; notes: string | null };
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Academic year" htmlFor="yearId">
          <Select id="yearId" name="yearId" required defaultValue={d?.yearId ?? years[0]?.id}>
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Class applied for" htmlFor="classId">
          <Select id="classId" name="classId" required defaultValue={d?.classId ?? ""}>
            <option value="" disabled>
              Choose a class
            </option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Applicant's full name" htmlFor="applicantName">
          <Input id="applicantName" name="applicantName" required maxLength={120} defaultValue={d?.applicantName} />
        </Field>
        <Field label="Date of birth" htmlFor="dateOfBirth" hint="Needed before approval.">
          <Input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={d?.dateOfBirth ?? ""} />
        </Field>
        <Field label="Guardian's name" htmlFor="guardianName">
          <Input id="guardianName" name="guardianName" required maxLength={120} defaultValue={d?.guardianName} />
        </Field>
        <Field label="Guardian's mobile" htmlFor="guardianPhone">
          <Input id="guardianPhone" name="guardianPhone" type="tel" inputMode="tel" defaultValue={d?.guardianPhone ?? ""} />
        </Field>
        <Field label="Guardian's email (optional)" htmlFor="guardianEmail">
          <Input id="guardianEmail" name="guardianEmail" type="email" defaultValue={d?.guardianEmail ?? ""} />
        </Field>
        <Field label="Previous school (optional)" htmlFor="previousSchool">
          <Input id="previousSchool" name="previousSchool" maxLength={200} defaultValue={d?.previousSchool ?? ""} />
        </Field>
      </div>
      <Field label="Notes (optional)" htmlFor="notes">
        <Textarea id="notes" name="notes" rows={2} maxLength={2000} defaultValue={d?.notes ?? ""} />
      </Field>
    </>
  );
}
