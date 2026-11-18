import { z } from "zod";

/**
 * Notification templates. Parameters are validated at render time, so a malformed stored
 * notification fails permanently instead of sending something broken.
 */
export interface RenderedMessage {
  subject: string;
  text: string;
}

const istTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";

const TEMPLATES = {
  "support.access_started": {
    params: z.object({ reason: z.string().max(500), expiresAt: z.iso.datetime({ offset: true }), by: z.string().max(200) }),
    render: (p: { reason: string; expiresAt: string; by: string }): RenderedMessage => ({
      subject: "Platform support opened access to your school",
      text: `${p.by} from Examio platform support opened temporary access to your school's records until ${istTime(p.expiresAt)}.\n\nReason given: ${p.reason}\n\nIf you did not expect this, contact Examio support.`,
    }),
  },
  "homework.published": {
    params: z.object({ title: z.string().max(150), subject: z.string().max(80), section: z.string().max(80), dueAt: z.iso.datetime({ offset: true }) }),
    render: (p: { title: string; subject: string; section: string; dueAt: string }): RenderedMessage => ({
      subject: `New homework: ${p.title}`,
      text: `${p.subject} homework for ${p.section}: "${p.title}". Due ${istTime(p.dueAt)}.

Open Examio to see the instructions.`,
    }),
  },
  "homework.reminder": {
    params: z.object({ title: z.string().max(150), section: z.string().max(80), dueAt: z.iso.datetime({ offset: true }) }),
    render: (p: { title: string; section: string; dueAt: string }): RenderedMessage => ({
      subject: `Reminder: ${p.title}`,
      text: `Homework "${p.title}" for ${p.section} is due ${istTime(p.dueAt)} and has not been submitted yet.`,
    }),
  },
  "homework.feedback": {
    params: z.object({ title: z.string().max(150), student: z.string().max(120) }),
    render: (p: { title: string; student: string }): RenderedMessage => ({
      subject: `Feedback on "${p.title}"`,
      text: `The teacher has returned feedback on ${p.student}'s homework "${p.title}". Open Examio to read it.`,
    }),
  },
  "announcement.published": {
    params: z.object({ title: z.string().max(150), excerpt: z.string().max(300) }),
    render: (p: { title: string; excerpt: string }): RenderedMessage => ({
      subject: p.title,
      text: `${p.excerpt}

Open Examio to read the full notice.`,
    }),
  },
  "fees.overdue": {
    params: z.object({ student: z.string().max(120), invoice: z.string().max(40), amount: z.string().max(40) }),
    render: (p: { student: string; invoice: string; amount: string }): RenderedMessage => ({
      subject: `Fee overdue: ${p.invoice}`,
      text: `${p.student}'s fee invoice ${p.invoice} is overdue. Outstanding: ${p.amount}.

You can see the statement and pay in Examio.`,
    }),
  },
  "results.released": {
    params: z.object({ title: z.string().max(150), student: z.string().max(120) }),
    render: (p: { title: string; student: string }): RenderedMessage => ({
      subject: `Results released: ${p.title}`,
      text: `${p.student}'s result for "${p.title}" is now available in Examio.`,
    }),
  },
  "results.corrected": {
    params: z.object({ title: z.string().max(150), student: z.string().max(120) }),
    render: (p: { title: string; student: string }): RenderedMessage => ({
      subject: `Result corrected: ${p.title}`,
      text: `${p.student}'s result for "${p.title}" was corrected by the school. Open Examio to see the current result.`,
    }),
  },
  "system.test": {
    params: z.object({ note: z.string().max(200) }),
    render: (p: { note: string }): RenderedMessage => ({ subject: "Test notification", text: `This is a test notification. ${p.note}` }),
  },
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export function isTemplateName(name: string): name is TemplateName {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, name);
}

/** Returns null when the template is unknown or its parameters are invalid. */
export function renderTemplate(name: string, params: unknown): RenderedMessage | null {
  if (!isTemplateName(name)) return null;
  const t = TEMPLATES[name];
  const parsed = t.params.safeParse(params);
  if (!parsed.success) return null;
  return (t.render as (p: unknown) => RenderedMessage)(parsed.data);
}
