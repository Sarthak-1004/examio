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
