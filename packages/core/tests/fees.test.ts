import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { feeStructureItems, invoices, ledgerEntries, payments, schoolMemberships, withContext, type RequestContext } from "@examio/db";
import { addDays, schoolToday } from "../src/dates";
import { AppError } from "../src/errors";
import { razorpayProvider, sandboxProvider } from "../src/payments/provider";
import {
  applyLateFees,
  cancelInvoice,
  decideAdjustment,
  decideConcession,
  getChildFees,
  getReceipt,
  getStudentAccount,
  issueInvoices,
  listPendingApprovals,
  recordOfflinePayment,
  requestAdjustment,
  requestConcession,
  sendOverdueReminders,
} from "../src/services/fees/billing";
import { computeLine, formatPaise, parseRupees } from "../src/services/fees/money";
import { completeSandboxPayment, createCheckoutOrder, processPaymentWebhook } from "../src/services/fees/online";
import { getCollections, getDefaulters, getReconciliation } from "../src/services/fees/reports";
import { addFeeStructureItem, approveFeeStructure, createFeeHead, createFeeStructure, getFeeStructure } from "../src/services/fees/setup";
import { createClass, createSection } from "../src/services/setup/structure";
import { createAcademicYear, setAcademicYearStatus } from "../src/services/setup/years";
import { createStaffMember } from "../src/services/staff/profiles";
import { createGuardianAccount } from "../src/services/students/guardians";
import { admitStudent } from "../src/services/students/profiles";
import { app, makeSchool, owner, truncateAll } from "./helpers";

/** Phase 8: fees, invoices, payments, approvals and the ledger. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? e.code : String(e)));
const sandbox = sandboxProvider();

describe("fees and payments", () => {
  let A: School;
  let B: School;
  let admin: RequestContext;
  let admin2: RequestContext;
  let finance: RequestContext;
  let parent: RequestContext;
  let otherParent: RequestContext;
  let k1: string;
  let k2: string;
  let structureId: string;
  let tuition: string;
  let transport: string;
  let dueOn: string;
  let today: string;

  const balanceOf = async (studentId: string) => (await getStudentAccount(app.db, finance, A.id, studentId)).balancePaise;

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("feea");
    B = await makeSchool("feeb");
    admin = A.ctx(A.adminId);
    today = schoolToday("Asia/Kolkata");
    const y = Number(today.slice(0, 4));
    const yearId = (await createAcademicYear(app.db, admin, A.id, { name: "This year", startsOn: `${y - 1}-06-01`, endsOn: `${y + 1}-03-31` })).id;
    await setAcademicYearStatus(app.db, admin, A.id, yearId, "current");
    const c5 = (await createClass(app.db, admin, A.id, { name: "Class 5", sortOrder: 5 })).id;
    const s5 = (await createSection(app.db, admin, A.id, { yearId, classId: c5, name: "A" })).id;
    // A second administrator (added directly, as platform support would) and a finance user.
    const second = randomUUID();
    await owner.db.execute(sql`insert into users (id, full_name, email, password_hash) values (${second}::uuid, 'Second Admin', ${`a2-${second}@fee.test`}, 'x')`);
    await owner.db.execute(sql`insert into school_memberships (school_id, user_id, role) values (${A.id}::uuid, ${second}::uuid, 'school_admin')`);
    admin2 = A.ctx(second);
    const f = await createStaffMember(app.db, admin, A.id, { fullName: "Fee Clerk", email: `clerk-${randomUUID().slice(0, 6)}@fee.test`, employeeNo: "F-1", role: "finance" });
    finance = A.ctx(f.userId);
    k1 = (await admitStudent(app.db, admin, A.id, { fullName: "Riya Fee", admissionNo: "FEE-1", admittedOn: `${y - 1}-06-01`, sectionId: s5 })).studentId;
    k2 = (await admitStudent(app.db, admin, A.id, { fullName: "Sahil Fee", admissionNo: "FEE-2", admittedOn: `${y - 1}-06-01`, sectionId: s5 })).studentId;
    parent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k1, { fullName: "Parent Riya", phone: "9876500011", relationship: "mother" })).userId);
    otherParent = A.ctx((await createGuardianAccount(app.db, admin, A.id, k2, { fullName: "Parent Sahil", phone: "9876500012", relationship: "father" })).userId);

    tuition = (await createFeeHead(app.db, finance, A.id, { name: "Tuition" })).id;
    transport = (await createFeeHead(app.db, finance, A.id, { name: "Transport", taxPercent: "18" })).id;
    structureId = (await createFeeStructure(app.db, finance, A.id, { yearId, classId: c5, name: "Class 5 fees", lateFee: "100", lateGraceDays: 5 })).id;
    dueOn = addDays(today, 10);
    await addFeeStructureItem(app.db, finance, A.id, structureId, { feeHeadId: tuition, label: "Term 1", amount: "12,000", dueOn });
    await addFeeStructureItem(app.db, finance, A.id, structureId, { feeHeadId: transport, label: "Term 1", amount: "2000.50", dueOn });
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("money: rupees parse to paise, Indian formatting, half-up rounding, tax after discount", () => {
    expect(parseRupees("₹ 1,23,456.5")).toBe(12345650);
    expect(parseRupees("12.345")).toBeNull();
    expect(parseRupees("-5")).toBeNull();
    expect(formatPaise(12345650)).toBe("₹1,23,456.50");
    expect(formatPaise(-500)).toBe("−₹5.00");
    expect(computeLine({ amountPaise: 1000000, taxBp: 1800, concessions: [{ kind: "percent", value: 1000 }] })).toEqual({ discountPaise: 100000, taxPaise: 162000, totalPaise: 1062000 });
    expect(computeLine({ amountPaise: 333, taxBp: 1800, concessions: [] })).toEqual({ discountPaise: 0, taxPaise: 60, totalPaise: 393 }); // 59.94 → 60
    expect(computeLine({ amountPaise: 500, taxBp: 0, concessions: [{ kind: "amount", value: 900 }] }).totalPaise).toBe(0); // discount capped
  });

  describe("structures and approvals", () => {
    it("finance drafts, a school administrator approves, and approved items never change", async () => {
      expect(await outcome(approveFeeStructure(app.db, finance, A.id, structureId))).toBe("FORBIDDEN");
      expect(await outcome(createFeeHead(app.db, A.ctx(A.teacherId), A.id, { name: "x" }))).toBe("FORBIDDEN");
      expect(await outcome(issueInvoices(app.db, finance, A.id, { structureId, dueOn }))).toBe("CONFLICT"); // not approved yet
      await approveFeeStructure(app.db, admin, A.id, structureId);
      expect(await outcome(addFeeStructureItem(app.db, finance, A.id, structureId, { feeHeadId: tuition, label: "Extra", amount: "1", dueOn }))).toBe("CONFLICT");
      const sneaky = await withContext(app.db, admin, (tx) =>
        tx.insert(feeStructureItems).values({ schoolId: A.id, structureId, feeHeadId: tuition, label: "Sneaky", amountPaise: 100, dueOn }),
      ).then(() => "inserted", () => "refused");
      expect(sneaky).toBe("refused");
      expect((await getFeeStructure(app.db, finance, A.id, structureId)).totalPaise).toBe(1400050);
    });

    it("concessions need an administrator other than the requester", async () => {
      const mine = await requestConcession(app.db, admin, A.id, { studentId: k1, feeHeadId: tuition, kind: "percent", value: "10", reason: "Sibling concession" });
      expect(await outcome(decideConcession(app.db, admin, A.id, mine.id, true))).toBe("FORBIDDEN");
      expect(await outcome(decideConcession(app.db, finance, A.id, mine.id, true))).toBe("FORBIDDEN");
      expect((await listPendingApprovals(app.db, finance, A.id)).map((p) => [p.type, p.amountText])).toEqual([["concession", "10.00%"]]);
      await decideConcession(app.db, admin2, A.id, mine.id, true);
      expect(await outcome(decideConcession(app.db, admin2, A.id, mine.id, true))).toBe("CONFLICT");
    });
  });

  describe("invoices and payments", () => {
    let inv1: string;
    let inv2: string;

    it("issues one instalment to the class once, with concessions and tax; a retry bills nobody twice", async () => {
      const r = await issueInvoices(app.db, finance, A.id, { structureId, dueOn });
      // k1: 12000 − 10% = 10800 + transport 2000.50 + 18% (360.09) = 13160.59; k2: 12000 + 2360.59 = 14360.59
      expect(r).toEqual({ issued: 2, skipped: 0, totalPaise: 1316059 + 1436059 });
      const counter = async () => ((await owner.db.execute(sql`select value from fee_counters where school_id = ${A.id}::uuid and kind = 'invoice'`)) as unknown as { value: number }[])[0]?.value;
      const before = await counter();
      expect(await issueInvoices(app.db, finance, A.id, { structureId, dueOn })).toEqual({ issued: 0, skipped: 2, totalPaise: 0 });
      // A retry takes no invoice numbers, so the numbering has no gaps.
      expect(await counter()).toBe(before);
      const a1 = await getStudentAccount(app.db, finance, A.id, k1);
      expect(a1.balancePaise).toBe(1316059);
      expect(a1.invoices[0]!.lines.map((l) => [l.description, l.discountPaise, l.taxPaise])).toEqual([
        ["Transport: Term 1", 0, 36009],
        ["Tuition: Term 1", 120000, 0],
      ]);
      expect(a1.invoices[0]!.number).toMatch(/^INV-\d{6}$/);
      inv1 = a1.invoices[0]!.id;
      inv2 = (await getStudentAccount(app.db, finance, A.id, k2)).invoices[0]!.id;
    });

    it("offline receipts: numbered, never more than outstanding, retry-safe", async () => {
      const key = randomUUID();
      const p1 = await recordOfflinePayment(app.db, finance, A.id, { invoiceId: inv1, amount: "5000", method: "cash", idempotencyKey: key });
      expect(p1.receiptNo).toMatch(/^RCT-\d{6}$/);
      expect((await recordOfflinePayment(app.db, finance, A.id, { invoiceId: inv1, amount: "5000", method: "cash", idempotencyKey: key })).replayed).toBe(true);
      expect(await balanceOf(k1)).toBe(1316059 - 500000);
      expect(await outcome(recordOfflinePayment(app.db, finance, A.id, { invoiceId: inv1, amount: "99999", method: "cash", idempotencyKey: randomUUID() }))).toBe("VALIDATION");
      expect(await outcome(recordOfflinePayment(app.db, finance, A.id, { invoiceId: inv1, amount: "10", method: "cheque", idempotencyKey: randomUUID() }))).toBe("VALIDATION"); // cheque needs a number
      expect(await outcome(recordOfflinePayment(app.db, parent, A.id, { invoiceId: inv1, amount: "10", method: "cash", idempotencyKey: randomUUID() }))).toBe("FORBIDDEN");
      // The ledger cannot be edited or deleted by anyone through the application.
      const edit = await withContext(app.db, finance, (tx) => tx.update(ledgerEntries).set({ amountPaise: 1 }).where(eq(ledgerEntries.studentId, k1))).then(() => "updated", () => "refused");
      const del = await withContext(app.db, admin, (tx) => tx.delete(ledgerEntries).where(eq(ledgerEntries.studentId, k1))).then(() => "deleted", () => "refused");
      expect([edit, del]).toEqual(["refused", "refused"]);
    });

    it("online: only a verified provider event captures, exactly once, for exactly the amount", async () => {
      expect(await outcome(createCheckoutOrder(app.db, parent, A.id, sandbox, inv2))).toBe("NOT_FOUND"); // not their child
      const order = await createCheckoutOrder(app.db, parent, A.id, sandbox, inv1);
      expect(order.amountPaise).toBe(1316059 - 500000);
      expect((await createCheckoutOrder(app.db, parent, A.id, sandbox, inv1)).orderId).toBe(order.orderId); // reused while pending
      // A browser cannot mark a payment captured.
      const forged = await withContext(app.db, parent, (tx) =>
        tx.insert(payments).values({ schoolId: A.id, studentId: k1, invoiceId: inv1, method: "online", amountPaise: order.amountPaise, status: "captured", provider: "sandbox", providerOrderId: "order_x", receiptNo: "RCT-X", capturedAt: new Date(), createdBy: String(parent.userId) }),
      ).then(() => "inserted", () => "refused");
      expect(forged).toBe("refused");
      // Bad signature, wrong amount, then the real event, then repeats.
      const good = sandbox.simulateEvent({ orderId: order.orderId, amountPaise: order.amountPaise, outcome: "captured", paymentId: "pay_ok_1" });
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: good.body, signature: "0".repeat(64), eventId: good.eventId })).toBe("invalid_signature");
      const wrong = sandbox.simulateEvent({ orderId: order.orderId, amountPaise: order.amountPaise - 100, outcome: "captured" });
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: wrong.body, signature: wrong.signature, eventId: wrong.eventId })).toBe("amount_mismatch");
      expect(await balanceOf(k1)).toBe(816059);
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: good.body, signature: good.signature, eventId: good.eventId })).toBe("captured");
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: good.body, signature: good.signature, eventId: good.eventId })).toBe("duplicate_event");
      const again = sandbox.simulateEvent({ orderId: order.orderId, amountPaise: order.amountPaise, outcome: "captured", paymentId: "pay_ok_1" });
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: again.body, signature: again.signature, eventId: again.eventId })).toBe("already_captured");
      const lateFail = sandbox.simulateEvent({ orderId: order.orderId, amountPaise: order.amountPaise, outcome: "failed" });
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: lateFail.body, signature: lateFail.signature, eventId: lateFail.eventId })).toBe("ignored_captured");
      expect(await balanceOf(k1)).toBe(0);
      const credits = await owner.db.select().from(ledgerEntries).where(eq(ledgerEntries.paymentId, order.paymentId));
      expect(credits.map((c) => c.amountPaise)).toEqual([-order.amountPaise]);
      expect(await outcome(createCheckoutOrder(app.db, parent, A.id, sandbox, inv1))).toBe("CONFLICT"); // paid
    });

    it("events arriving out of order: a failure first, then the capture, still credits once", async () => {
      const order = await createCheckoutOrder(app.db, otherParent, A.id, sandbox, inv2);
      expect(await completeSandboxPayment(app.db, otherParent, A.id, sandbox, order.paymentId, "failed")).toBe("failed");
      const cap = sandbox.simulateEvent({ orderId: order.orderId, amountPaise: order.amountPaise, outcome: "captured" });
      expect(await processPaymentWebhook(app.db, sandbox, { rawBody: cap.body, signature: cap.signature, eventId: cap.eventId })).toBe("captured");
      expect(await balanceOf(k2)).toBe(0);
      expect(await outcome(completeSandboxPayment(app.db, parent, A.id, sandbox, order.paymentId, "captured"))).toBe("NOT_FOUND"); // not their payment
    });

    it("the Razorpay adapter checks the webhook signature with the webhook secret", () => {
      const rzp = razorpayProvider({ keyId: "rzp_test_x", keySecret: "s", webhookSecret: "whsec", fetchImpl: (() => Promise.reject(new Error("no network"))) as typeof fetch });
      const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 100, currency: "INR" } } } });
      const sig = createHmac("sha256", "whsec").update(body).digest("hex");
      expect(rzp.parseWebhook(body, sig, "evt_1")).toMatchObject({ eventId: "evt_1", orderId: "order_1", paymentId: "pay_1", status: "captured", amountPaise: 100 });
      expect(rzp.parseWebhook(body, sig.replace(/.$/, "0"), "evt_1")).toBeNull();
      expect(rzp.parseWebhook(body, createHmac("sha256", "other").update(body).digest("hex"), "evt_1")).toBeNull();
    });

    it("parents see their own child's statement and receipts only; other schools see nothing", async () => {
      const mine = await getChildFees(app.db, parent, A.id, k1);
      expect(mine.balancePaise).toBe(0);
      expect(mine.invoices.map((i) => [i.structureName, i.balancePaise])).toEqual([["School fees", 0]]); // parents see invoices, not fee structures
      expect(mine.payments.filter((p) => p.status === "captured").length).toBe(2);
      expect(await outcome(getChildFees(app.db, parent, A.id, k2))).toBe("NOT_FOUND");
      const receipt = mine.payments.find((p) => p.status === "captured")!;
      expect((await getReceipt(app.db, parent, A.id, receipt.id)).studentName).toBe("Riya Fee");
      expect(await outcome(getReceipt(app.db, otherParent, A.id, receipt.id))).toBe("NOT_FOUND");
      const fromB = await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select({ id: invoices.id }).from(invoices));
      expect(fromB).toHaveLength(0);
    });
  });

  describe("late fees, adjustments, cancellation and reports", () => {
    it("late fees are added once after the grace days; adjustments post only when approved by someone else", async () => {
      // A fresh unpaid instalment, overdue beyond the grace days.
      const late = addDays(today, 20);
      const s2 = (await createFeeStructure(app.db, finance, A.id, { yearId: (await getFeeStructure(app.db, finance, A.id, structureId)).yearId, classId: (await getFeeStructure(app.db, finance, A.id, structureId)).classId, name: "Activities", lateFee: "250", lateGraceDays: 2 })).id;
      await addFeeStructureItem(app.db, finance, A.id, s2, { feeHeadId: tuition, label: "Activities", amount: "1000", dueOn: late });
      await approveFeeStructure(app.db, admin, A.id, s2);
      await issueInvoices(app.db, finance, A.id, { structureId: s2, dueOn: late });
      await owner.db.update(invoices).set({ dueOn: addDays(today, -5) }).where(eq(invoices.structureId, s2));
      expect(await applyLateFees(app.db, finance, A.id)).toEqual({ applied: 2, totalPaise: 50000 });
      expect(await applyLateFees(app.db, finance, A.id)).toEqual({ applied: 0, totalPaise: 0 });

      // Overdue reminders skip a parent whose membership has ended instead of failing the whole run.
      const remindersFor = async (userId: string) =>
        ((await owner.db.execute(sql`select count(*)::int as n from notifications where recipient_user_id = ${userId}::uuid and template = 'fees.overdue'`)) as unknown as { n: number }[])[0]!.n;
      await owner.db.update(schoolMemberships).set({ status: "revoked" }).where(eq(schoolMemberships.userId, parent.userId!));
      await sendOverdueReminders(app.db, finance, A.id);
      expect(await remindersFor(parent.userId!)).toBe(0);
      await owner.db.update(schoolMemberships).set({ status: "active" }).where(eq(schoolMemberships.userId, parent.userId!));
      await owner.db.execute(sql`delete from notifications where template = 'fees.overdue'`);
      await sendOverdueReminders(app.db, finance, A.id);
      expect(await remindersFor(parent.userId!)).toBeGreaterThan(0);
      expect(await balanceOf(k2)).toBe(125000);
      expect((await getDefaulters(app.db, finance, A.id)).map((d) => [d.admissionNo, d.overduePaise])).toEqual(expect.arrayContaining([["FEE-2", 125000]]));

      const waiver = await requestAdjustment(app.db, finance, A.id, { studentId: k2, kind: "waiver", amount: "250", reason: "Late fee waived by principal" });
      expect(await balanceOf(k2)).toBe(125000); // nothing until approved
      expect(await outcome(decideAdjustment(app.db, finance, A.id, waiver.id, true))).toBe("FORBIDDEN");
      await decideAdjustment(app.db, admin, A.id, waiver.id, true);
      expect(await balanceOf(k2)).toBe(100000);

      // Reversing an offline receipt recorded in error, and refunding an online payment.
      const cash = (await getStudentAccount(app.db, finance, A.id, k1)).payments.find((p) => p.method === "cash")!;
      const rev = await requestAdjustment(app.db, finance, A.id, { studentId: k1, paymentId: cash.id, kind: "receipt_reversal", amount: "", reason: "Cash entered twice" });
      expect(await outcome(requestAdjustment(app.db, finance, A.id, { studentId: k1, paymentId: cash.id, kind: "receipt_reversal", amount: "", reason: "Again" }))).toBe("CONFLICT");
      const before = await balanceOf(k1);
      await decideAdjustment(app.db, admin, A.id, rev.id, true);
      expect(await balanceOf(k1)).toBe(before + cash.amountPaise);
      expect((await getReceipt(app.db, finance, A.id, cash.id)).reversed).toBe(true);
      const online = (await getStudentAccount(app.db, finance, A.id, k2)).payments.find((p) => p.method === "online" && p.status === "captured")!;
      const refund = await requestAdjustment(app.db, admin, A.id, { studentId: k2, paymentId: online.id, kind: "refund", amount: "100", reason: "Overcharged transport" });
      expect(await outcome(decideAdjustment(app.db, admin, A.id, refund.id, true))).toBe("FORBIDDEN"); // own request
      await decideAdjustment(app.db, admin2, A.id, refund.id, true);
      expect(await balanceOf(k2)).toBe(110000);
    });

    it("an invoice with payments cannot be cancelled; an unpaid one is reversed, not deleted", async () => {
      const acc = await getStudentAccount(app.db, finance, A.id, k2);
      const paid = acc.invoices.find((i) => i.structureName === "Class 5 fees")!;
      expect(await outcome(cancelInvoice(app.db, admin, A.id, paid.id, "Wrong class"))).toBe("CONFLICT");
      const unpaid = acc.invoices.find((i) => i.structureName === "Activities")!;
      expect(await outcome(cancelInvoice(app.db, finance, A.id, unpaid.id, "Wrong class"))).toBe("FORBIDDEN");
      await cancelInvoice(app.db, admin, A.id, unpaid.id, "Activity not offered");
      const after = await getStudentAccount(app.db, finance, A.id, k2);
      expect(after.invoices.find((i) => i.id === unpaid.id)).toMatchObject({ status: "cancelled", balancePaise: 0 });
      expect(after.ledger.filter((e) => e.kind === "reversal").length).toBeGreaterThanOrEqual(2); // charge and late fee
    });

    it("reports: collections by method, and the reconciliation check finds no mismatch", async () => {
      const c = await getCollections(app.db, finance, A.id, { from: addDays(today, -1), to: addDays(today, 1) });
      expect(c.byMethod.map((m) => m.method).sort()).toEqual(["cash", "online"]);
      expect(c.refundsPaise).toBe(10000);
      const rec = await getReconciliation(app.db, finance, A.id);
      expect(rec.mismatches).toEqual([]);
      expect(await outcome(getCollections(app.db, A.ctx(A.teacherId), A.id, { from: today, to: today }))).toBe("FORBIDDEN");
    });
  });
});
