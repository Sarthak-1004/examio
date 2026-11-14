import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { gradingBands, gradingSchemes, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { withCapability } from "../../capabilities";
import { AppError } from "../../errors";
import { bpToPercent, mapSetupError, parse, percentToBp, trimmed, uuidField } from "./common";

/**
 * Grading schemes. A scheme has a pass mark and grade bands, each defined by its lower bound;
 * a band covers its minimum up to (not including) the next band's minimum, and the top band
 * includes 100%. Every scheme must have a band starting at 0%, so every percentage maps to
 * exactly one grade. Values are basis points (hundredths of a percent): exact, no rounding.
 *
 * Product note: no universal pass mark or grade scale is assumed. The CBSE-style preset is a
 * starting point the school can change.
 */
export interface GradeBand {
  label: string;
  minBp: number;
  description: string | null;
}

export interface GradingScheme {
  id: string;
  name: string;
  passBp: number;
  isDefault: boolean;
  archived: boolean;
  bands: GradeBand[];
}

const bandSchema = z.object({
  label: trimmed("Grade", 1, 10),
  minPercent: z.string().trim(),
  description: z.string().trim().max(100, "Description must be at most 100 characters.").optional(),
});

const schemeSchema = z
  .object({
    name: trimmed("Scheme name", 1, 60),
    passPercent: z.string().trim(),
    bands: z.array(bandSchema).min(2, "Add at least two grades.").max(20, "At most 20 grades."),
  })
  .transform((s, ctx) => {
    const passBp = percentToBp(s.passPercent);
    if (passBp === null) {
      ctx.addIssue({ code: "custom", path: ["passPercent"], message: "Pass mark must be a percentage from 0 to 100, with at most two decimals." });
      return z.NEVER;
    }
    const bands: GradeBand[] = [];
    s.bands.forEach((b, i) => {
      const minBp = percentToBp(b.minPercent);
      if (minBp === null) ctx.addIssue({ code: "custom", path: ["bands", i, "minPercent"], message: `Grade ${b.label}: the minimum must be a percentage from 0 to 100.` });
      else bands.push({ label: b.label, minBp, description: b.description ? b.description : null });
    });
    const mins = new Set(bands.map((b) => b.minBp));
    const labels = new Set(bands.map((b) => b.label.toLowerCase()));
    if (mins.size !== bands.length) ctx.addIssue({ code: "custom", path: ["bands"], message: "Two grades have the same minimum percentage." });
    if (labels.size !== bands.length) ctx.addIssue({ code: "custom", path: ["bands"], message: "Two grades have the same name." });
    if (bands.length === s.bands.length && !mins.has(0)) ctx.addIssue({ code: "custom", path: ["bands"], message: "One grade must start at 0%, so every mark gets a grade." });
    return { name: s.name, passBp, bands: bands.sort((a, b) => b.minBp - a.minBp) };
  });
export type GradingSchemeInput = z.input<typeof schemeSchema>;

/** CBSE-style 8-point scale (A1–E) with a 33% pass mark, as an editable starting point. */
export const CBSE_STYLE_PRESET: GradingSchemeInput = {
  name: "CBSE-style (A1–E)",
  passPercent: "33",
  bands: [
    { label: "A1", minPercent: "91" },
    { label: "A2", minPercent: "81" },
    { label: "B1", minPercent: "71" },
    { label: "B2", minPercent: "61" },
    { label: "C1", minPercent: "51" },
    { label: "C2", minPercent: "41" },
    { label: "D", minPercent: "33" },
    { label: "E", minPercent: "0", description: "Needs improvement" },
  ],
};

/**
 * The grade for a percentage (basis points). Evaluated on the unrounded value, as the business
 * rules require. Bands must include one starting at 0.
 */
export function gradeFor(bands: readonly GradeBand[], bp: number): { label: string } {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new Error("Percentage out of range");
  const sorted = [...bands].sort((a, b) => b.minBp - a.minBp);
  const band = sorted.find((b) => bp >= b.minBp);
  if (!band) throw new Error("Grading scheme has no band starting at 0");
  return { label: band.label };
}

export function passes(scheme: Pick<GradingScheme, "passBp">, bp: number): boolean {
  return bp >= scheme.passBp;
}

export { bpToPercent, percentToBp };

const duplicate = { grading_schemes_school_name_unique: ["name", "A grading scheme with this name already exists."] as [string, string] };

export async function listGradingSchemes(db: Db, ctx: RequestContext, schoolId: string, opts: { includeArchived?: boolean } = {}): Promise<GradingScheme[]> {
  return withCapability(db, ctx, schoolId, "school.setup.view", async (tx) => {
    const schemes = await tx
      .select({ id: gradingSchemes.id, name: gradingSchemes.name, passBp: gradingSchemes.passBp, isDefault: gradingSchemes.isDefault, archivedAt: gradingSchemes.archivedAt })
      .from(gradingSchemes)
      .where(and(eq(gradingSchemes.schoolId, schoolId), opts.includeArchived ? undefined : isNull(gradingSchemes.archivedAt)))
      .orderBy(asc(gradingSchemes.name));
    const bands = await tx
      .select({ schemeId: gradingBands.schemeId, label: gradingBands.label, minBp: gradingBands.minBp, description: gradingBands.description })
      .from(gradingBands)
      .where(eq(gradingBands.schoolId, schoolId));
    return schemes.map((s) => ({
      id: s.id,
      name: s.name,
      passBp: s.passBp,
      isDefault: s.isDefault,
      archived: s.archivedAt !== null,
      bands: bands.filter((b) => b.schemeId === s.id).map(({ label, minBp, description }) => ({ label, minBp, description })).sort((a, b) => b.minBp - a.minBp),
    }));
  });
}

async function writeBands(tx: Tx, schoolId: string, schemeId: string, bands: GradeBand[]): Promise<void> {
  await tx.delete(gradingBands).where(and(eq(gradingBands.schoolId, schoolId), eq(gradingBands.schemeId, schemeId)));
  await tx.insert(gradingBands).values(bands.map((b) => ({ schoolId, schemeId, label: b.label, minBp: b.minBp, description: b.description })));
}

/** Creates a scheme. The school's first scheme becomes its default. */
export async function createGradingScheme(db: Db, ctx: RequestContext, schoolId: string, input: GradingSchemeInput): Promise<{ id: string }> {
  const data = parse(schemeSchema, input);
  try {
    return await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const [existingDefault] = await tx
        .select({ id: gradingSchemes.id })
        .from(gradingSchemes)
        .where(and(eq(gradingSchemes.schoolId, schoolId), eq(gradingSchemes.isDefault, true), isNull(gradingSchemes.archivedAt)));
      const [row] = await tx.insert(gradingSchemes).values({ schoolId, name: data.name, passBp: data.passBp, isDefault: !existingDefault }).returning({ id: gradingSchemes.id });
      await writeBands(tx, schoolId, row!.id, data.bands);
      await audit(tx, { action: "setup.grading.created", actorUserId: actor.userId, schoolId, entityType: "grading_scheme", entityId: row!.id, data: { name: data.name, passBp: data.passBp, bands: data.bands.length } });
      return { id: row!.id };
    });
  } catch (e) {
    mapSetupError(e, { duplicate });
  }
}

/** Replaces a scheme's name, pass mark and bands in one step. */
export async function updateGradingScheme(db: Db, ctx: RequestContext, schoolId: string, schemeId: string, input: GradingSchemeInput): Promise<void> {
  parse(uuidField("Grading scheme"), schemeId);
  const data = parse(schemeSchema, input);
  try {
    await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
      const updated = await tx
        .update(gradingSchemes)
        .set({ name: data.name, passBp: data.passBp, updatedAt: sql`now()` })
        .where(and(eq(gradingSchemes.schoolId, schoolId), eq(gradingSchemes.id, schemeId)))
        .returning({ id: gradingSchemes.id });
      if (updated.length === 0) throw new AppError("NOT_FOUND", "Grading scheme not found.");
      await writeBands(tx, schoolId, schemeId, data.bands);
      await audit(tx, { action: "setup.grading.updated", actorUserId: actor.userId, schoolId, entityType: "grading_scheme", entityId: schemeId, data: { name: data.name, passBp: data.passBp, bands: data.bands.length } });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapSetupError(e, { duplicate });
  }
}

export async function setDefaultGradingScheme(db: Db, ctx: RequestContext, schoolId: string, schemeId: string): Promise<void> {
  parse(uuidField("Grading scheme"), schemeId);
  await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
    const [target] = await tx
      .select({ archivedAt: gradingSchemes.archivedAt })
      .from(gradingSchemes)
      .where(and(eq(gradingSchemes.schoolId, schoolId), eq(gradingSchemes.id, schemeId)));
    if (!target) throw new AppError("NOT_FOUND", "Grading scheme not found.");
    if (target.archivedAt) throw new AppError("CONFLICT", "An archived scheme cannot be the default.");
    await tx.update(gradingSchemes).set({ isDefault: false }).where(and(eq(gradingSchemes.schoolId, schoolId), eq(gradingSchemes.isDefault, true)));
    await tx.update(gradingSchemes).set({ isDefault: true, updatedAt: sql`now()` }).where(eq(gradingSchemes.id, schemeId));
    await audit(tx, { action: "setup.grading.default_set", actorUserId: actor.userId, schoolId, entityType: "grading_scheme", entityId: schemeId });
  });
}

/** Archive keeps the scheme for history; the default scheme cannot be archived. */
export async function setGradingSchemeArchived(db: Db, ctx: RequestContext, schoolId: string, schemeId: string, archived: boolean): Promise<void> {
  parse(uuidField("Grading scheme"), schemeId);
  await withCapability(db, ctx, schoolId, "school.setup.manage", async (tx, actor) => {
    const [s] = await tx.select({ isDefault: gradingSchemes.isDefault }).from(gradingSchemes).where(and(eq(gradingSchemes.schoolId, schoolId), eq(gradingSchemes.id, schemeId)));
    if (!s) throw new AppError("NOT_FOUND", "Grading scheme not found.");
    if (archived && s.isDefault) throw new AppError("CONFLICT", "Make another scheme the default before archiving this one.");
    await tx.update(gradingSchemes).set({ archivedAt: archived ? sql`now()` : null, isDefault: false }).where(eq(gradingSchemes.id, schemeId));
    await audit(tx, { action: `setup.grading.${archived ? "archived" : "restored"}`, actorUserId: actor.userId, schoolId, entityType: "grading_scheme", entityId: schemeId });
  });
}
