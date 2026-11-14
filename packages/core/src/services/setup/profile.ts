import { eq } from "drizzle-orm";
import { z } from "zod";
import { schools, type Db, type RequestContext } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { emailSchema, phoneSchema } from "../../validation";
import { mapSetupError, parse, trimmed } from "./common";

/**
 * The school's own profile, edited by its administrators: name, short name, contact details,
 * timezone and accent colour. Board, medium and status remain platform decisions (enforced in
 * the database); the school code never changes.
 */
/**
 * True when the runtime can use this IANA time zone. Checked by trying it, not by looking it up
 * in Intl.supportedValuesOf, which lists canonical names only (e.g. Asia/Calcutta, not the
 * current Asia/Kolkata).
 */
export function isValidTimezone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const optional = <T extends z.ZodType>(schema: T) => z.union([z.literal("").transform(() => null), schema]).nullable().optional();

const profileSchema = z.object({
  name: trimmed("School name", 3, 200),
  shortName: optional(trimmed("Short name", 1, 30)),
  address: optional(trimmed("Address", 1, 500)),
  contactEmail: optional(emailSchema),
  contactPhone: optional(phoneSchema),
  timezone: z.string().trim().refine(isValidTimezone, "Choose a valid time zone, e.g. Asia/Kolkata."),
  brandColor: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^#[0-9a-f]{6}$/, "Colour must look like #2953e0."),
  ),
});
export type SchoolProfileInput = z.input<typeof profileSchema>;

export interface SchoolProfile {
  name: string;
  shortName: string | null;
  address: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  timezone: string;
  brandColor: string | null;
}

export async function getSchoolProfile(db: Db, ctx: RequestContext, schoolId: string): Promise<SchoolProfile> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const [s] = await tx
      .select({ name: schools.name, shortName: schools.shortName, address: schools.address, contactEmail: schools.contactEmail, contactPhone: schools.contactPhone, timezone: schools.timezone, brandColor: schools.brandColor })
      .from(schools)
      .where(eq(schools.id, schoolId));
    return s!;
  });
}

export async function updateSchoolProfile(db: Db, ctx: RequestContext, schoolId: string, input: SchoolProfileInput): Promise<void> {
  const data = parse(profileSchema, input);
  const values = {
    name: data.name,
    shortName: data.shortName ?? null,
    address: data.address ?? null,
    contactEmail: data.contactEmail ?? null,
    contactPhone: data.contactPhone ?? null,
    timezone: data.timezone,
    brandColor: data.brandColor ?? null,
  };
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      await tx.update(schools).set(values).where(eq(schools.id, schoolId));
      // Contact details are personal-ish data: record which fields changed, not their values.
      await audit(tx, { action: "setup.profile.updated", actorUserId: actor.userId, schoolId, entityType: "school", entityId: schoolId, data: { name: values.name, timezone: values.timezone, fields: Object.keys(values) } });
    });
  } catch (e) {
    mapSetupError(e);
  }
}
