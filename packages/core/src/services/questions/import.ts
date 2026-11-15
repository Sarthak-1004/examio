import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { topics, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { parseCsv } from "../../csv";
import { AppError } from "../../errors";
import { withIdempotency } from "../../idempotency";
import { createInTransaction, validateContent, type ContentInput, type QuestionContent } from "./questions";

/**
 * Question import from CSV (Phase 9), in two steps like the other imports:
 * 1. Check: every row is validated exactly like the editor (type, options, answer, marks) and its
 *    subject, chapter and topic are looked up; errors say what to fix. Nothing is saved.
 * 2. Import: the same file and choices are re-checked and imported in ONE transaction, all rows
 *    or none, guarded by the check's fingerprint and an idempotency key.
 *
 * Columns (header row; common spellings recognised): subject (code or name), chapter, topic,
 * type (single choice / true-false / descriptive; "mcq", "tf" accepted), difficulty, marks,
 * negative_marks, question, option_a … option_f, answer (A-F, or true/false), explanation,
 * model_answer. Imported questions are drafts (or in review when chosen). Missing chapters and
 * topics are an error unless "create missing" is chosen.
 */
export const MAX_QUESTION_IMPORT_ROWS = 300;
const MAX_IMPORT_BYTES = 512 * 1024;

const FIELDS = ["subject", "chapter", "topic", "type", "difficulty", "marks", "negative_marks", "question", "option_a", "option_b", "option_c", "option_d", "option_e", "option_f", "answer", "explanation", "model_answer"] as const;
type Field = (typeof FIELDS)[number];
const ALIASES: Partial<Record<Field, string[]>> = {
  subject: ["subject", "subjectcode", "subjectname"],
  chapter: ["chapter", "unit", "lesson"],
  topic: ["topic", "subtopic"],
  type: ["type", "questiontype", "qtype"],
  difficulty: ["difficulty", "level"],
  marks: ["marks", "mark", "points", "score"],
  negative_marks: ["negativemarks", "negative", "penalty", "minus"],
  question: ["question", "questiontext", "stem", "text"],
  answer: ["answer", "correct", "correctanswer", "key"],
  explanation: ["explanation", "solution", "reason"],
  model_answer: ["modelanswer", "sampleanswer"],
};
const key = (h: string) => h.trim().toLowerCase().replace(/[\s._-]+/g, "");
const fieldFor = (h: string): Field | null => {
  const k = key(h);
  for (const f of FIELDS) {
    if (key(f) === k || (ALIASES[f] ?? []).includes(k)) return f;
    const m = /^option([a-f])$/.exec(k) ?? /^opt([a-f])$/.exec(k) ?? /^([a-f])$/.exec(k);
    if (m && f === `option_${m[1]}`) return f;
  }
  return null;
};

const TYPE_ALIASES: Record<string, ContentInput["type"]> = {
  singlechoice: "single_choice", single: "single_choice", mcq: "single_choice", multiplechoice: "single_choice", sc: "single_choice",
  truefalse: "true_false", tf: "true_false", trueorfalse: "true_false",
  descriptive: "descriptive", long: "descriptive", short: "descriptive", subjective: "descriptive", written: "descriptive",
};

export interface QuestionImportRow {
  line: number;
  subject: string;
  path: string;
  type: string;
  stem: string;
  errors: string[];
  /** Chapters/topics this row needs created (when "create missing" is on). */
  creates: string[];
}

export interface QuestionImportPreview {
  fingerprint: string;
  rows: QuestionImportRow[];
  valid: number;
  invalid: number;
  ignoredColumns: string[];
  fileErrors: string[];
  willCreate: string[];
}

interface Planned {
  row: QuestionImportRow;
  subjectId: string | null;
  chapter: string;
  topic: string;
  content: QuestionContent | null;
}

function fingerprintOf(text: string, createMissing: boolean, submit: boolean): string {
  return createHash("sha256").update(`${createMissing ? 1 : 0}${submit ? 1 : 0}\n${text.replace(/\r\n/g, "\n").trim()}`).digest("hex");
}

async function plan(tx: Tx, schoolId: string, text: string, createMissing: boolean): Promise<{ planned: Planned[]; ignored: string[]; fileErrors: string[] }> {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) return { planned: [], ignored: [], fileErrors: ["The file is larger than 512 KB."] };
  const table = parseCsv(text);
  if (table.length === 0) return { planned: [], ignored: [], fileErrors: ["The file is empty."] };
  const header = table[0]!;
  const index = new Map<Field, number>();
  const ignored: string[] = [];
  header.forEach((h, i) => {
    const f = fieldFor(h);
    if (f && !index.has(f)) index.set(f, i);
    else if (h.trim()) ignored.push(h.trim());
  });
  const fileErrors: string[] = [];
  for (const f of ["subject", "type", "question"] as const) if (!index.has(f)) fileErrors.push(`No column for "${f}" was found in the header row.`);
  const body = table.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (body.length === 0) fileErrors.push("The file has a header but no question rows.");
  if (body.length > MAX_QUESTION_IMPORT_ROWS) fileErrors.push(`At most ${MAX_QUESTION_IMPORT_ROWS} questions per import; this file has ${body.length}.`);
  if (fileErrors.length) return { planned: [], ignored, fileErrors };

  const subjects = (await tx.execute(sql`
    select id, lower(code) as code, lower(name) as name, app_can_author_subject(school_id, id) as allowed
    from subjects where school_id = ${schoolId}::uuid and archived_at is null`)) as unknown as { id: string; code: string; name: string; allowed: boolean }[];
  const tree = (await tx.execute(sql`
    select t.id, t.subject_id as "subjectId", t.level::text as level, lower(t.name) as name, lower(p.name) as parent, t.archived_at is not null as archived
    from topics t left join topics p on p.id = t.parent_id where t.school_id = ${schoolId}::uuid`)) as unknown as { id: string; subjectId: string; level: string; name: string; parent: string | null; archived: boolean }[];

  const cell = (r: string[], f: Field) => (index.has(f) ? (r[index.get(f)!] ?? "").trim() : "");
  const planned: Planned[] = body.map((r, i) => {
    const line = i + 2;
    const errors: string[] = [];
    const creates: string[] = [];
    const subjectText = cell(r, "subject");
    const subj = subjects.find((s) => s.code === subjectText.toLowerCase() || s.name === subjectText.toLowerCase());
    if (!subj) errors.push(`No subject "${subjectText}" (use its code or name).`);
    else if (!subj.allowed) errors.push(`You cannot add questions for ${subjectText}: you do not teach it.`);
    const chapter = cell(r, "chapter");
    const topic = cell(r, "topic");
    if (topic && !chapter) errors.push("A topic needs its chapter.");
    if (subj && chapter) {
      const ch = tree.find((t) => t.subjectId === subj.id && t.level === "chapter" && t.name === chapter.toLowerCase());
      if (ch?.archived) errors.push(`Chapter "${chapter}" is archived.`);
      if (!ch) createMissing ? creates.push(`Chapter "${chapter}"`) : errors.push(`No chapter "${chapter}" in ${subjectText}. Add it, or choose "create missing chapters and topics".`);
      if (topic) {
        const tp = ch && tree.find((t) => t.subjectId === subj.id && t.level === "topic" && t.parent === chapter.toLowerCase() && t.name === topic.toLowerCase());
        if (tp && tp.archived) errors.push(`Topic "${topic}" is archived.`);
        if (!tp) createMissing ? creates.push(`Topic "${chapter} › ${topic}"`) : errors.push(`No topic "${topic}" in chapter "${chapter}". Add it, or choose "create missing chapters and topics".`);
      }
    }
    const typeRaw = key(cell(r, "type"));
    const type = TYPE_ALIASES[typeRaw] ?? (typeRaw === "" ? "" : typeRaw);
    const options = (["option_a", "option_b", "option_c", "option_d", "option_e", "option_f"] as const).map((f) => cell(r, f));
    const answer = cell(r, "answer");
    let correct = "";
    if (type === "single_choice") {
      const letter = /^[a-f]$/i.test(answer) ? answer.toLowerCase().charCodeAt(0) - 97 : -1;
      const nonEmpty = options.map((o, idx) => ({ o, idx })).filter((x) => x.o !== "");
      const byText = nonEmpty.findIndex((x) => x.o.toLowerCase() === answer.toLowerCase());
      const pos = letter >= 0 ? nonEmpty.findIndex((x) => x.idx === letter) : byText;
      if (pos < 0) errors.push("Answer: give the letter of the correct option (A-F).");
      correct = String(pos);
    } else if (type === "true_false") {
      const a = answer.toLowerCase();
      correct = ["true", "t", "yes", "y"].includes(a) ? "true" : ["false", "f", "no", "n"].includes(a) ? "false" : "";
      if (!correct) errors.push('Answer: write "true" or "false".');
    }
    let content: QuestionContent | null = null;
    if (errors.length === 0) {
      try {
        content = validateContent({
          type,
          difficulty: cell(r, "difficulty").toLowerCase() || "medium",
          stem: cell(r, "question"),
          options,
          correct,
          modelAnswer: cell(r, "model_answer"),
          explanation: cell(r, "explanation"),
          marks: cell(r, "marks") || "1",
          negativeMarks: cell(r, "negative_marks"),
        });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        errors.push(e.message);
      }
    }
    return {
      row: { line, subject: subjectText, path: [chapter, topic].filter(Boolean).join(" › "), type: cell(r, "type"), stem: cell(r, "question").slice(0, 120), errors, creates },
      subjectId: subj?.id ?? null,
      chapter,
      topic,
      content,
    };
  });
  return { planned, ignored, fileErrors };
}

function shape(p: Awaited<ReturnType<typeof plan>>, fingerprint: string): QuestionImportPreview {
  const rows = p.planned.map((x) => x.row);
  const invalid = rows.filter((r) => r.errors.length > 0).length;
  return { fingerprint, rows, valid: rows.length - invalid, invalid, ignoredColumns: p.ignored, fileErrors: p.fileErrors, willCreate: [...new Set(rows.flatMap((r) => r.creates))] };
}

export async function previewQuestionImport(db: Db, ctx: RequestContext, schoolId: string, input: { text: string; createMissing: boolean; submit: boolean }): Promise<QuestionImportPreview> {
  return withCapability(db, ctx, schoolId, "school.questions.manage", async (tx) => shape(await plan(tx, schoolId, input.text, input.createMissing), fingerprintOf(input.text, input.createMissing, input.submit)));
}

export async function commitQuestionImport(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { text: string; createMissing: boolean; submit: boolean; fingerprint: string; idempotencyKey: string },
): Promise<{ created: number; topicsCreated: number; replayed: boolean }> {
  if (fingerprintOf(input.text, input.createMissing, input.submit) !== input.fingerprint) throw new AppError("CONFLICT", "The file or the choices changed after the check. Check the file again before importing.");
  const out = await withCapability(db, ctx, schoolId, "school.questions.manage", (tx, actor) =>
    withIdempotency(tx, ctx, { operation: "questions.import", key: input.idempotencyKey, request: { fingerprint: input.fingerprint }, schoolId }, async () => {
      const p = await plan(tx, schoolId, input.text, input.createMissing);
      if (p.fileErrors.length) throw new AppError("VALIDATION", p.fileErrors[0]!);
      const bad = p.planned.filter((x) => x.row.errors.length > 0).length;
      if (bad) throw new AppError("VALIDATION", `${bad} row(s) have errors. Fix the file and check it again. Nothing was imported.`);
      const cache = new Map<string, string>();
      let topicsCreated = 0;
      const ensure = async (subjectId: string, level: "chapter" | "topic", name: string, parentId: string | null): Promise<string> => {
        const k = `${subjectId}|${level}|${parentId ?? ""}|${name.toLowerCase()}`;
        const hit = cache.get(k);
        if (hit) return hit;
        const [found] = (await tx.execute(sql`
          select id from topics where school_id = ${schoolId}::uuid and subject_id = ${subjectId}::uuid and level = ${level}::topic_level
            and ${parentId ? sql`parent_id = ${parentId}::uuid` : sql`parent_id is null`} and lower(name) = lower(${name})`)) as unknown as { id: string }[];
        let id = found?.id;
        if (!id) {
          const [t] = await tx.insert(topics).values({ schoolId, subjectId, level, parentId, name }).returning({ id: topics.id });
          id = t!.id;
          topicsCreated++;
        }
        cache.set(k, id);
        return id;
      };
      for (const x of p.planned) {
        let topicId: string | null = null;
        if (x.chapter) {
          const chapterId = await ensure(x.subjectId!, "chapter", x.chapter, null);
          topicId = x.topic ? await ensure(x.subjectId!, "topic", x.topic, chapterId) : chapterId;
        }
        await createInTransaction(tx, actor.userId, schoolId, x.subjectId!, topicId, x.content!, input.submit);
      }
      await audit(tx, { action: "question.imported", actorUserId: actor.userId, schoolId, entityType: "question", data: { created: p.planned.length, topicsCreated, fingerprint: input.fingerprint } });
      return { created: p.planned.length, topicsCreated };
    }),
  );
  return { ...out.result, replayed: out.replayed };
}
