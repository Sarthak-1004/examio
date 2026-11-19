import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { platformInvoices, platformPlans, schoolSubscriptions, subscriptionEvents, withContext, type Db, type RequestContext, type Tx } from "@examio/db";
import { audit } from "../../audit";
import { requirePlatformAdmin } from "../../authz";
import { PLAN_MODULE_LABELS, withCapability, type AccessState, type PlanModule } from "../../capabilities";
import { addDays, schoolToday } from "../../dates";
import { uniqueViolation } from "../../db-errors";
import { AppError } from "../../errors";
import { parseRupees } from "../fees/money";
import { isoDate, parse, trimmed, uuidField } from "../setup/common";

/**
 * Subscriptions and platform billing (Phase 15.1; decisions 2026-11-20).
 *
 * - Plans (platform administrators): modules and a cap on active students.
 * - One subscription per school: plan, start and end dates, audited overrides of modules and
 *   the cap. No subscription: full access without an end date.
 * - Access state: active, due (14 days before the end), grace (15 days after), read-only. The
 *   database computes it (app_school_access) and enforces it (app_read_only_guard); see
 *   withCapability.
 * - Manual invoices: numbered per year; recording a payment with the same reference again is
 *   a no-op; a paid invoice extends the subscription to the end of its period if later.
 */

export const ALL_MODULES = Object.keys(PLAN_MODULE_LABELS) as PlanModule[];
const moduleList = z.array(z.enum(ALL_MODULES as [PlanModule, ...PlanModule[]], { message: "Unknown module." }));

async function platformTx<T>(db: Db, ctx: RequestContext, fn: (tx: Tx, actorUserId: string) => Promise<T>): Promise<T> {
  requirePlatformAdmin(ctx);
  return withContext(db, ctx, (tx) => fn(tx, ctx.userId!));
}

/* ------------------------------------------------------------------ plans */

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  modules: PlanModule[];
  maxStudents: number | null;
  pricePaise: number | null;
  periodMonths: number;
  archived: boolean;
  schools: number;
}

export async function listPlans(db: Db, ctx: RequestContext): Promise<PlanRow[]> {
  return platformTx(db, ctx, async (tx) =>
    (await tx.execute(sql`
      select p.id, p.code, p.name, p.modules, p.max_students as "maxStudents", p.price_paise::float8 as "pricePaise", p.period_months as "periodMonths",
             p.archived_at is not null as archived, (select count(*)::int from school_subscriptions s where s.plan_id = p.id) as schools
      from platform_plans p order by p.archived_at is not null, lower(p.name)`)) as unknown as PlanRow[],
  );
}

const planSchema = z.object({
  name: trimmed("Name", 1, 80),
  modules: z.array(z.string()).pipe(moduleList),
  maxStudents: z.union([z.literal("").transform(() => null), z.coerce.number().int("Students: a whole number.").min(1, "Students: 1 to 100,000.").max(100_000, "Students: 1 to 100,000.")]).nullable().optional(),
  price: z.string().optional(),
  periodMonths: z.coerce.number().int().min(1, "Period: 1 to 36 months.").max(36, "Period: 1 to 36 months."),
});

function pricePaise(price: string | undefined): number | null {
  if (!price?.trim()) return null;
  const p = parseRupees(price);
  if (p === null) throw new AppError("VALIDATION", "Price: enter rupees, for example 50000.", { price: "Not a valid amount." });
  return p;
}

export async function createPlan(db: Db, ctx: RequestContext, input: z.input<typeof planSchema> & { code: string }): Promise<{ id: string }> {
  const code = parse(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,19}$/, "Code: 2 to 20 lowercase letters, digits or hyphens."), input.code);
  const v = parse(planSchema, input);
  try {
    return await platformTx(db, ctx, async (tx, actorUserId) => {
      const [p] = await tx
        .insert(platformPlans)
        .values({ code, name: v.name, modules: v.modules, maxStudents: v.maxStudents ?? null, pricePaise: pricePaise(input.price), periodMonths: v.periodMonths })
        .returning({ id: platformPlans.id });
      await audit(tx, { action: "platform.plan_created", actorUserId, entityType: "platform_plan", entityId: p!.id, data: { code, modules: v.modules, maxStudents: v.maxStudents ?? null } });
      return { id: p!.id };
    });
  } catch (e) {
    if (uniqueViolation(e)?.includes("platform_plans_code")) throw new AppError("CONFLICT", "A plan with this code already exists.", { code: "Already used." });
    throw e;
  }
}

/** Changes a plan; schools on it are affected at once (their own overrides still apply). */
export async function updatePlan(db: Db, ctx: RequestContext, planId: string, input: z.input<typeof planSchema> & { archived?: boolean }): Promise<void> {
  parse(uuidField("Plan"), planId);
  const v = parse(planSchema, input);
  await platformTx(db, ctx, async (tx, actorUserId) => {
    const r = await tx
      .update(platformPlans)
      .set({
        name: v.name,
        modules: v.modules,
        maxStudents: v.maxStudents ?? null,
        pricePaise: pricePaise(input.price),
        periodMonths: v.periodMonths,
        ...(input.archived === undefined ? {} : { archivedAt: input.archived ? sql`now()` : null }),
      })
      .where(eq(platformPlans.id, planId))
      .returning({ id: platformPlans.id });
    if (r.length === 0) throw new AppError("NOT_FOUND", "Plan not found.");
    await audit(tx, { action: "platform.plan_updated", actorUserId, entityType: "platform_plan", entityId: planId, data: { modules: v.modules, maxStudents: v.maxStudents ?? null, archived: input.archived ?? null } });
  });
}

/* ------------------------------------------------------------------ a school's subscription */

export interface SubscriptionView {
  schoolId: string;
  plan: { id: string; code: string; name: string } | null;
  startsOn: string | null;
  endsOn: string | null;
  access: AccessState;
  modules: PlanModule[];
  modulesAdded: PlanModule[];
  modulesRemoved: PlanModule[];
  maxStudents: number | null;
  maxStudentsOverride: number | null;
  activeStudents: number;
  history: { kind: string; detail: Record<string, unknown>; reason: string | null; actor: string; at: Date }[];
  invoices: InvoiceRow[];
}

export interface InvoiceRow {
  id: string;
  number: string;
  periodFrom: string;
  periodTo: string;
  amountPaise: number;
  note: string | null;
  status: "issued" | "paid" | "cancelled";
  issuedAt: Date;
  paidOn: string | null;
  paymentReference: string | null;
  cancelledReason: string | null;
}

async function subscriptionView(tx: Tx, schoolId: string): Promise<SubscriptionView> {
  const [s] = (await tx.execute(sql`
    select sc.id as "schoolId", p.id as "planId", p.code, p.name, sub.starts_on::text as "startsOn", sub.ends_on::text as "endsOn",
           app_school_access(sc.id) as access, app_school_modules(sc.id) as modules,
           coalesce(sub.modules_added, '{}') as "modulesAdded", coalesce(sub.modules_removed, '{}') as "modulesRemoved",
           app_school_student_cap(sc.id) as "maxStudents", sub.max_students_override as "maxStudentsOverride",
           app_school_active_students(sc.id) as "activeStudents"
    from schools sc left join school_subscriptions sub on sub.school_id = sc.id left join platform_plans p on p.id = sub.plan_id
    where sc.id = ${schoolId}::uuid`)) as unknown as (Omit<SubscriptionView, "plan" | "history" | "invoices"> & { planId: string | null; code: string | null; name: string | null })[];
  if (!s) throw new AppError("NOT_FOUND", "School not found.");
  const history = ((await tx.execute(sql`
    select e.kind, e.detail, e.reason, coalesce(u.full_name, 'Examio') as actor, e.at
    from subscription_events e left join users u on u.id = e.actor_user_id where e.school_id = ${schoolId}::uuid order by e.at desc limit 50`)) as unknown as SubscriptionView["history"]).map((h) => ({
    ...h,
    at: new Date(h.at),
  }));
  const invoices = ((await tx.execute(sql`
    select id, number, period_from::text as "periodFrom", period_to::text as "periodTo", amount_paise::float8 as "amountPaise", note, status::text as status,
           issued_at as "issuedAt", paid_on::text as "paidOn", payment_reference as "paymentReference", cancelled_reason as "cancelledReason"
    from platform_invoices where school_id = ${schoolId}::uuid order by issued_at desc limit 50`)) as unknown as InvoiceRow[]).map((i) => ({ ...i, issuedAt: new Date(i.issuedAt) }));
  const { planId, code, name, ...rest } = s;
  return { ...rest, plan: planId ? { id: planId, code: code!, name: name! } : null, history, invoices };
}

/** A school's subscription, history and invoices for the platform administrator. */
export async function getSubscription(db: Db, ctx: RequestContext, schoolId: string): Promise<SubscriptionView> {
  parse(uuidField("School"), schoolId);
  return platformTx(db, ctx, (tx) => subscriptionView(tx, schoolId));
}

async function logEvent(tx: Tx, schoolId: string, actorUserId: string, kind: string, detail: Record<string, unknown>, reason: string | null) {
  await tx.insert(subscriptionEvents).values({ schoolId, kind, detail, reason, actorUserId });
  await audit(tx, { action: `platform.subscription_${kind}`, actorUserId, schoolId, entityType: "school", entityId: schoolId, data: { ...detail, reason } });
}

/** Assigns or changes a school's plan and dates (a reason is needed for a change). */
export async function setSubscription(db: Db, ctx: RequestContext, schoolId: string, input: { planId: string; startsOn: string; endsOn: string; reason?: string }): Promise<void> {
  parse(uuidField("School"), schoolId);
  const planId = parse(uuidField("Plan"), input.planId);
  const startsOn = parse(isoDate("start date"), input.startsOn);
  const endsOn = parse(isoDate("end date"), input.endsOn);
  if (endsOn < startsOn) throw new AppError("VALIDATION", "The end date cannot be before the start date.", { endsOn: "Before the start." });
  const reason = input.reason?.trim() ? parse(trimmed("Reason", 3, 300), input.reason) : null;
  await platformTx(db, ctx, async (tx, actorUserId) => {
    const [p] = await tx.select().from(platformPlans).where(eq(platformPlans.id, planId));
    if (!p || p.archivedAt) throw new AppError("NOT_FOUND", "Plan not found.", { planId: "Choose a plan." });
    const [school] = (await tx.execute(sql`select id from schools where id = ${schoolId}::uuid`)) as unknown as { id: string }[];
    if (!school) throw new AppError("NOT_FOUND", "School not found.");
    const [old] = await tx.select().from(schoolSubscriptions).where(eq(schoolSubscriptions.schoolId, schoolId)).for("update");
    if (old && !reason) throw new AppError("VALIDATION", "Give a reason for changing the subscription.", { reason: "Required for a change." });
    if (old) {
      await tx.update(schoolSubscriptions).set({ planId, startsOn, endsOn, updatedBy: actorUserId, updatedAt: sql`now()` }).where(eq(schoolSubscriptions.schoolId, schoolId));
    } else {
      await tx.insert(schoolSubscriptions).values({ schoolId, planId, startsOn, endsOn, updatedBy: actorUserId });
    }
    await logEvent(tx, schoolId, actorUserId, old ? "changed" : "assigned", { plan: p.code, startsOn, endsOn, from: old ? { planId: old.planId, startsOn: old.startsOn, endsOn: old.endsOn } : null }, reason);
  });
}

/** Overrides modules and the student cap for one school, always with a reason. */
export async function setOverrides(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { modulesAdded: string[]; modulesRemoved: string[]; maxStudentsOverride?: string; reason: string },
): Promise<void> {
  parse(uuidField("School"), schoolId);
  const added = parse(moduleList, input.modulesAdded);
  const removed = parse(moduleList, input.modulesRemoved);
  if (added.some((m) => removed.includes(m))) throw new AppError("VALIDATION", "A module cannot be both added and removed.");
  const cap = input.maxStudentsOverride?.trim() ? parse(z.coerce.number().int().min(1, "Students: 1 to 100,000.").max(100_000, "Students: 1 to 100,000."), input.maxStudentsOverride) : null;
  const reason = parse(trimmed("Reason", 3, 300), input.reason);
  await platformTx(db, ctx, async (tx, actorUserId) => {
    const [old] = await tx.select().from(schoolSubscriptions).where(eq(schoolSubscriptions.schoolId, schoolId)).for("update");
    if (!old) throw new AppError("CONFLICT", "Assign a plan before overriding it.");
    await tx
      .update(schoolSubscriptions)
      .set({ modulesAdded: added, modulesRemoved: removed, maxStudentsOverride: cap, updatedBy: actorUserId, updatedAt: sql`now()` })
      .where(eq(schoolSubscriptions.schoolId, schoolId));
    await logEvent(tx, schoolId, actorUserId, "overridden", { modulesAdded: added, modulesRemoved: removed, maxStudentsOverride: cap }, reason);
  });
}

/* ------------------------------------------------------------------ invoices */

export async function createPlatformInvoice(
  db: Db,
  ctx: RequestContext,
  schoolId: string,
  input: { periodFrom: string; periodTo: string; amount: string; note?: string },
): Promise<{ id: string; number: string }> {
  parse(uuidField("School"), schoolId);
  const periodFrom = parse(isoDate("period start"), input.periodFrom);
  const periodTo = parse(isoDate("period end"), input.periodTo);
  if (periodTo < periodFrom) throw new AppError("VALIDATION", "The period cannot end before it starts.", { periodTo: "Before the start." });
  const amount = parseRupees(input.amount);
  if (!amount) throw new AppError("VALIDATION", "Amount: enter rupees, for example 60000.", { amount: "Not a valid amount." });
  const note = input.note?.trim() ? parse(trimmed("Note", 1, 300), input.note) : null;
  return platformTx(db, ctx, async (tx, actorUserId) => {
    const [school] = (await tx.execute(sql`select id from schools where id = ${schoolId}::uuid`)) as unknown as { id: string }[];
    if (!school) throw new AppError("NOT_FOUND", "School not found.");
    // Numbers are sequential per calendar year: PI-2026-0001.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('platform_invoice_number'))`);
    const year = schoolToday("Asia/Kolkata").slice(0, 4);
    const [n] = (await tx.execute(sql`
      select coalesce(max(substring(number from 9)::int), 0) + 1 as next from platform_invoices where number like ${`PI-${year}-%`}`)) as unknown as { next: number }[];
    const number = `PI-${year}-${String(n?.next ?? 1).padStart(4, "0")}`;
    const [i] = await tx.insert(platformInvoices).values({ schoolId, number, periodFrom, periodTo, amountPaise: amount, note, issuedBy: actorUserId }).returning({ id: platformInvoices.id });
    await audit(tx, { action: "platform.invoice_issued", actorUserId, schoolId, entityType: "platform_invoice", entityId: i!.id, data: { number, periodFrom, periodTo, amountPaise: amount } });
    return { id: i!.id, number };
  });
}

/**
 * Records payment of an invoice. The same reference again changes nothing (safe to retry); a
 * different payment on a paid invoice is refused. The subscription is extended to the end of the
 * invoice's period if that is later than its current end date.
 */
export async function recordPlatformPayment(
  db: Db,
  ctx: RequestContext,
  invoiceId: string,
  input: { paidOn: string; reference: string },
): Promise<{ alreadyRecorded: boolean; extendedTo: string | null }> {
  parse(uuidField("Invoice"), invoiceId);
  const paidOn = parse(isoDate("payment date"), input.paidOn);
  const reference = parse(trimmed("Reference", 1, 80), input.reference);
  return platformTx(db, ctx, async (tx, actorUserId) => {
    // Read before locking: a lock applies the update policy, which hides paid invoices.
    const [seen] = await tx.select().from(platformInvoices).where(eq(platformInvoices.id, invoiceId));
    if (!seen) throw new AppError("NOT_FOUND", "Invoice not found.");
    const [locked] = seen.status === "issued" ? await tx.select().from(platformInvoices).where(eq(platformInvoices.id, invoiceId)).for("update") : [seen];
    const inv = locked ?? seen;
    if (inv.status === "paid") {
      if (inv.paymentReference === reference) return { alreadyRecorded: true, extendedTo: null };
      throw new AppError("CONFLICT", `This invoice is already paid (reference ${inv.paymentReference}).`);
    }
    if (inv.status === "cancelled") throw new AppError("CONFLICT", "This invoice is cancelled.");
    await tx
      .update(platformInvoices)
      .set({ status: "paid", paidOn, paymentReference: reference, recordedBy: actorUserId, recordedAt: sql`now()` })
      .where(and(eq(platformInvoices.id, invoiceId), eq(platformInvoices.status, "issued")));
    await audit(tx, { action: "platform.invoice_paid", actorUserId, schoolId: inv.schoolId, entityType: "platform_invoice", entityId: invoiceId, data: { number: inv.number, paidOn } });
    const [sub] = await tx.select().from(schoolSubscriptions).where(eq(schoolSubscriptions.schoolId, inv.schoolId)).for("update");
    let extendedTo: string | null = null;
    if (sub && inv.periodTo > sub.endsOn) {
      await tx.update(schoolSubscriptions).set({ endsOn: inv.periodTo, updatedBy: actorUserId, updatedAt: sql`now()` }).where(eq(schoolSubscriptions.schoolId, inv.schoolId));
      await logEvent(tx, inv.schoolId, actorUserId, "renewed", { invoice: inv.number, from: sub.endsOn, to: inv.periodTo }, null);
      extendedTo = inv.periodTo;
    }
    return { alreadyRecorded: false, extendedTo };
  });
}

export async function cancelPlatformInvoice(db: Db, ctx: RequestContext, invoiceId: string, reason: string): Promise<void> {
  parse(uuidField("Invoice"), invoiceId);
  const why = parse(trimmed("Reason", 3, 300), reason);
  await platformTx(db, ctx, async (tx, actorUserId) => {
    const r = await tx
      .update(platformInvoices)
      .set({ status: "cancelled", cancelledReason: why })
      .where(and(eq(platformInvoices.id, invoiceId), eq(platformInvoices.status, "issued")))
      .returning({ schoolId: platformInvoices.schoolId, number: platformInvoices.number });
    if (r.length === 0) throw new AppError("CONFLICT", "Only an unpaid invoice can be cancelled.");
    await audit(tx, { action: "platform.invoice_cancelled", actorUserId, schoolId: r[0]!.schoolId, entityType: "platform_invoice", entityId: invoiceId, data: { number: r[0]!.number, reason: why } });
  });
}

/* ------------------------------------------------------------------ what the school sees */

export interface SchoolAccess {
  access: AccessState;
  endsOn: string | null;
  /** Days until the end date (negative after it); null without an end date. */
  daysLeft: number | null;
  /** The last day of grace, after which the school is read-only. */
  graceEndsOn: string | null;
  modules: PlanModule[];
}

/** Access state and modules for page layouts (any member; banners and navigation). */
export async function getSchoolAccess(db: Db, ctx: RequestContext, schoolId: string): Promise<SchoolAccess> {
  return withCapability(db, ctx, schoolId, "school.view", async (tx, actor) => {
    const [s] = (await tx.execute(sql`
      select sub.ends_on::text as "endsOn", (sub.ends_on - (now() at time zone sc.timezone)::date)::int as "daysLeft"
      from schools sc left join school_subscriptions sub on sub.school_id = sc.id where sc.id = ${schoolId}::uuid`)) as unknown as { endsOn: string | null; daysLeft: number | null }[];
    return {
      access: actor.access,
      endsOn: s?.endsOn ?? null,
      daysLeft: s?.daysLeft ?? null,
      graceEndsOn: s?.endsOn ? addDays(s.endsOn, 15) : null,
      modules: [...actor.modules],
    };
  });
}

/** The school's plan, usage, history and invoices for its administrators. */
export async function getMySubscription(db: Db, ctx: RequestContext, schoolId: string): Promise<SubscriptionView> {
  return withCapability(db, ctx, schoolId, "school.subscription.view", (tx) => subscriptionView(tx, schoolId));
}
