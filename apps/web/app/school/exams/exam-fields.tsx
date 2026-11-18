import { Field, Input, Textarea } from "@/components/ui";

export const EXAM_STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "slate" | "red" }> = {
  draft: { label: "Draft", tone: "amber" },
  pending_approval: { label: "Waiting for approval", tone: "blue" },
  published: { label: "Published", tone: "green" },
  cancelled: { label: "Cancelled", tone: "red" },
};

/** Title, instructions, window (school time), duration, attempts and negative marking. */
export function ExamFields({
  d,
}: {
  d?: { title: string; instructions: string | null; opensLocal: string; closesLocal: string; durationMinutes: number; attemptLimit: number; negativeMarking: boolean };
}) {
  return (
    <>
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required maxLength={150} defaultValue={d?.title} />
      </Field>
      <Field label="Instructions (optional)" htmlFor="instructions" hint="Shown to students before they start.">
        <Textarea id="instructions" name="instructions" rows={3} maxLength={5000} defaultValue={d?.instructions ?? ""} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Opens" htmlFor="opensAt" hint="School time.">
          <Input id="opensAt" name="opensAt" type="datetime-local" defaultValue={d?.opensLocal} />
        </Field>
        <Field label="Closes" htmlFor="closesAt" hint="No attempt can start after this.">
          <Input id="closesAt" name="closesAt" type="datetime-local" defaultValue={d?.closesLocal} />
        </Field>
        <Field label="Duration (minutes)" htmlFor="durationMinutes">
          <Input id="durationMinutes" name="durationMinutes" type="number" min={5} max={600} required defaultValue={d?.durationMinutes ?? 60} />
        </Field>
        <Field label="Attempts per student" htmlFor="attemptLimit" hint="Usually 1. Retakes for one student: an accommodation.">
          <Input id="attemptLimit" name="attemptLimit" type="number" min={1} max={5} required defaultValue={d?.attemptLimit ?? 1} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="negativeMarking" defaultChecked={d?.negativeMarking ?? true} />
        Apply the questions&apos; negative marks for wrong answers
      </label>
    </>
  );
}
