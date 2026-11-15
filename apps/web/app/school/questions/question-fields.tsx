import Link from "next/link";
import type { ChapterNode, ChoiceOption, QuestionType } from "@examio/core";
import { Field, Input, Select, Textarea, cx } from "@/components/ui";

export const TYPE_LABEL: Record<QuestionType, string> = { single_choice: "Single choice", true_false: "True / false", descriptive: "Descriptive" };

export interface FieldDefaults {
  stem?: string;
  options?: ChoiceOption[] | null;
  correct?: string;
  modelAnswer?: string | null;
  explanation?: string | null;
  marks?: string;
  negativeMarks?: string;
  difficulty?: string;
  topicId?: string | null;
  imageFileId?: string | null;
}

/** Type tabs as links, so each form shows only its own fields (works without JavaScript). */
export function TypeTabs({ current, href }: { current: QuestionType; href: (t: QuestionType) => string }) {
  return (
    <nav aria-label="Question type" className="flex flex-wrap gap-2">
      {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
        <Link
          key={t}
          href={href(t)}
          aria-current={t === current ? "page" : undefined}
          className={cx("inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-inset", t === current ? "bg-brand-50 text-brand-700 ring-brand-600" : "text-slate-700 ring-slate-300 hover:bg-slate-50")}
        >
          {TYPE_LABEL[t]}
        </Link>
      ))}
    </nav>
  );
}

/** The editor's fields for one question type. */
export function QuestionFields({ type, chapters, d = {} }: { type: QuestionType; chapters: ChapterNode[]; d?: FieldDefaults }) {
  const opts = d.options ?? [];
  const correctIndex = type === "single_choice" && d.correct ? String(Math.max(0, opts.findIndex((o) => o.id === d.correct))) : (d.correct ?? "");
  return (
    <div className="space-y-4">
      <input type="hidden" name="type" value={type} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Chapter or topic" htmlFor="q-topic" className="sm:col-span-2">
          <Select id="q-topic" name="topicId" defaultValue={d.topicId ?? ""}>
            <option value="">None</option>
            {chapters
              .filter((c) => !c.archived)
              .map((c) => (
                <optgroup key={c.id} label={c.name}>
                  <option value={c.id}>{c.name} (whole chapter)</option>
                  {c.topics
                    .filter((t) => !t.archived)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {c.name} › {t.name}
                      </option>
                    ))}
                </optgroup>
              ))}
          </Select>
        </Field>
        <Field label="Difficulty" htmlFor="q-difficulty">
          <Select id="q-difficulty" name="difficulty" defaultValue={d.difficulty ?? "medium"}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
        </Field>
      </div>
      <Field label="Question" htmlFor="q-stem" hint="Plain text; line breaks are kept.">
        <Textarea id="q-stem" name="stem" rows={4} required maxLength={5000} defaultValue={d.stem ?? ""} />
      </Field>
      {type === "single_choice" && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-900">Options (2 to 6) and the correct one</legend>
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="correct" value={String(i)} defaultChecked={correctIndex === String(i)} className="h-5 w-5" />
                  <span className="sr-only">Option {String.fromCharCode(65 + i)} is correct</span>
                  <span className="w-5 font-semibold text-slate-600">{String.fromCharCode(65 + i)}</span>
                </label>
                <label className="sr-only" htmlFor={`q-opt${i}`}>
                  Option {String.fromCharCode(65 + i)}
                </label>
                <Input id={`q-opt${i}`} name={`option${i}`} maxLength={1000} defaultValue={opts[i]?.text ?? ""} className="flex-1" />
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {type === "true_false" && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-900">Correct answer</legend>
          <div className="flex gap-4">
            {(["true", "false"] as const).map((v) => (
              <label key={v} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="correct" value={v} defaultChecked={d.correct === v} className="h-5 w-5" />
                {v === "true" ? "True" : "False"}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {type === "descriptive" && (
        <Field label="Model answer" htmlFor="q-model" hint="Optional; shown to graders, never to students.">
          <Textarea id="q-model" name="modelAnswer" rows={4} maxLength={5000} defaultValue={d.modelAnswer ?? ""} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Marks" htmlFor="q-marks" hint="0.01 to 100, e.g. 1 or 0.5.">
          <Input id="q-marks" name="marks" inputMode="decimal" required defaultValue={d.marks ?? "1"} />
        </Field>
        {type !== "descriptive" && (
          <Field label="Negative marks" htmlFor="q-neg" hint="Deducted for a wrong answer. 0 = none.">
            <Input id="q-neg" name="negativeMarks" inputMode="decimal" defaultValue={d.negativeMarks ?? "0"} />
          </Field>
        )}
      </div>
      <Field label="Explanation" htmlFor="q-expl" hint="Optional; shown after an attempt in practice (later phase), never during an exam.">
        <Textarea id="q-expl" name="explanation" rows={3} maxLength={5000} defaultValue={d.explanation ?? ""} />
      </Field>
      <Field label="Image" htmlFor="q-image" hint="Optional PNG, JPEG or WebP up to 2 MB.">
        <input id="q-image" name="image" type="file" accept=".png,.jpg,.jpeg,.webp" className="block text-sm" />
      </Field>
      {d.imageFileId && (
        <>
          <input type="hidden" name="currentImageId" value={d.imageFileId} />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="removeImage" className="h-5 w-5 rounded border-slate-300" />
            Remove the current image
          </label>
        </>
      )}
    </div>
  );
}
