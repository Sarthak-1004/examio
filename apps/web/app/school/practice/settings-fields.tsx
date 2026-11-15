import type { ChapterNode } from "@examio/core";
import { Field, Input, Select, Textarea } from "@/components/ui";

export const SET_STATUS: Record<string, { label: string; tone: "amber" | "green" | "slate" }> = {
  draft: { label: "Draft", tone: "amber" },
  published: { label: "Published", tone: "green" },
  archived: { label: "Archived", tone: "slate" },
};

/** Title, topic, instructions, attempt limit and feedback rule of a practice set. */
export function SettingsFields({
  chapters,
  d,
}: {
  chapters: ChapterNode[];
  d?: { title: string; topicId: string | null; instructions: string | null; attemptLimit: number | null; feedback: string };
}) {
  return (
    <>
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required maxLength={150} defaultValue={d?.title} />
      </Field>
      {chapters.length > 0 && (
        <Field label="Chapter / topic (optional)" htmlFor="topicId" hint="Shown to students as the set's focus.">
          <Select id="topicId" name="topicId" defaultValue={d?.topicId ?? ""}>
            <option value="">None</option>
            {chapters.map((c) => (
              <optgroup key={c.id} label={c.name}>
                <option value={c.id}>{c.name}</option>
                {c.topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {c.name} › {t.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Instructions (optional)" htmlFor="instructions">
        <Textarea id="instructions" name="instructions" rows={3} maxLength={2000} defaultValue={d?.instructions ?? ""} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Attempt limit" htmlFor="attemptLimit" hint="Leave empty for unlimited attempts.">
          <Input id="attemptLimit" name="attemptLimit" type="number" min={1} max={50} defaultValue={d?.attemptLimit ?? ""} />
        </Field>
        <Field label="Show answers and score" htmlFor="feedback">
          <Select id="feedback" name="feedback" defaultValue={d?.feedback ?? "immediate"}>
            <option value="immediate">Right after submitting</option>
            <option value="after_close">After the practice closes</option>
          </Select>
        </Field>
      </div>
    </>
  );
}
