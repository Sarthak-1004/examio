import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { jobs, notifications, schoolMemberships, users, withContext, type RequestContext } from "@examio/db";
import { isRlsViolation } from "../src/db-errors";
import { AppError } from "../src/errors";
import { runWorkerOnce } from "../src/jobs/queue";
import { createLogger } from "../src/logger";
import { emailAdapterFromEnv, sandboxEmailAdapter, type OutgoingEmail } from "../src/notifications/email";
import { listMyNotifications, markNotificationRead, queueNotification } from "../src/notifications/notifications";
import { renderTemplate } from "../src/notifications/templates";
import { startSupportAccess } from "../src/services/support-access";
import os from "node:os";
import path from "node:path";
import { localDiskStorage } from "../src/files/storage";
import { createJobHandlers } from "../src/worker";

const storageDir = path.join(os.tmpdir(), "examio-test-files-notifications");
import { app, makeSchool, makeUser, owner, truncateAll } from "./helpers";

/** Phase 2, task 02.4: notifications are queued atomically and delivered once, email in sandbox. */
type School = Awaited<ReturnType<typeof makeSchool>>;
const quiet = createLogger({}, { write: () => {} });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("notifications", () => {
  let A: School;
  let B: School;
  let platform: RequestContext;
  const sent: OutgoingEmail[] = [];
  const work = () =>
    runWorkerOnce(app.db, {
      workerId: "notify-test",
      handlers: createJobHandlers({ db: app.db, email: sandboxEmailAdapter((m) => sent.push(m)), log: quiet, storage: localDiskStorage(storageDir), scanner: null }),
      log: quiet,
    });

  beforeAll(async () => {
    await truncateAll();
    A = await makeSchool("nta");
    B = await makeSchool("ntb");
    platform = { userId: await makeUser({ isPlatformAdmin: true, fullName: "Priya Support" }), schoolId: null, isPlatformAdmin: true };
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("support access notifies the school's admins in the app and by sandboxed email, exactly once", async () => {
    const second = await makeUser({ email: null, phone: "9000011111", fullName: "No Email Admin" });
    await owner.db.insert(schoolMemberships).values({ schoolId: A.id, userId: second, role: "school_admin" });
    const reason = "Ticket 77: teacher cannot sign in";

    const { id } = await startSupportAccess(app.db, platform, { schoolId: A.id, reason });
    const queued = await owner.db.select().from(notifications).where(eq(notifications.dedupeKey, `support:${id}`));
    // Two admins in the app; email only for the one with an address. Nothing for teachers or students.
    expect(queued.map((n) => `${n.recipientUserId === A.adminId ? "admin" : "second"}:${n.channel}`).sort()).toEqual(["admin:email", "admin:in_app", "second:in_app"]);
    expect(queued.every((n) => n.status === "pending")).toBe(true);

    expect(await work()).toMatchObject({ claimed: 3, succeeded: 3 });
    const delivered = await owner.db.select().from(notifications).where(eq(notifications.dedupeKey, `support:${id}`));
    expect(delivered.find((n) => n.channel === "email")).toMatchObject({ status: "sandboxed", provider: "sandbox" });
    expect(delivered.filter((n) => n.channel === "in_app").every((n) => n.status === "delivered")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Platform support opened access to your school");
    expect(sent[0]!.text).toContain(reason);
    expect(sent[0]!.text).toContain("Priya Support");

    // A duplicated delivery job sends nothing more.
    await owner.db.update(jobs).set({ status: "queued", runAt: new Date(Date.now() - 1000) }).where(eq(jobs.kind, "notification.deliver"));
    await work();
    expect(sent).toHaveLength(1);

    const mine = await listMyNotifications(app.db, A.ctx(A.adminId));
    expect(mine.map((n) => n.subject)).toEqual(["Platform support opened access to your school"]);
    expect(mine[0]!.readAt).toBeNull();
    await markNotificationRead(app.db, A.ctx(A.adminId), mine[0]!.id);
    expect((await listMyNotifications(app.db, A.ctx(A.adminId)))[0]!.readAt).not.toBeNull();
  });

  it("people see only their own notifications", async () => {
    const [theirs] = await owner.db.select().from(notifications).where(and(eq(notifications.recipientUserId, A.adminId), eq(notifications.channel, "in_app")));
    expect(await listMyNotifications(app.db, A.ctx(A.teacherId))).toHaveLength(0);
    expect(await listMyNotifications(app.db, B.ctx(B.adminId))).toHaveLength(0);
    const steal = await failure(markNotificationRead(app.db, A.ctx(A.teacherId), theirs!.id));
    expect(steal instanceof AppError && steal.code).toBe("NOT_FOUND");
    const direct = await withContext(app.db, B.ctx(B.adminId), (tx) => tx.select().from(notifications));
    expect(direct).toHaveLength(0);
    const tamper = await failure(withContext(app.db, A.ctx(A.adminId), (tx) => tx.update(notifications).set({ status: "pending" }).where(eq(notifications.id, theirs!.id))));
    expect(isRlsViolation(tamper)).toBe(true);
  });

  it("a member can notify people in their own school only", async () => {
    const queue = (ctx: RequestContext, recipient: string, school: string) =>
      withContext(app.db, ctx, (tx) =>
        queueNotification(tx, { recipientUserId: recipient, schoolId: school, channels: ["in_app"], template: "system.test", params: { note: "hi" }, dedupeKey: `t-${recipient}-${school}` }),
      );
    expect(await queue(A.ctx(A.teacherId), A.studentId, A.id)).toBe(1);
    expect(await queue(A.ctx(A.teacherId), A.studentId, A.id)).toBe(1 - 1); // same key: nothing new
    expect(isRlsViolation(await failure(queue(A.ctx(A.teacherId), B.studentId, B.id)))).toBe(true);
    expect(isRlsViolation(await failure(queue(A.ctx(A.teacherId), B.studentId, A.id)))).toBe(true);
    const direct = await failure(
      withContext(app.db, A.ctx(A.adminId), (tx) =>
        tx.insert(notifications).values({ recipientUserId: A.studentId, schoolId: A.id, channel: "in_app", template: "system.test", params: {}, dedupeKey: "x" }),
      ),
    );
    expect(isRlsViolation(direct)).toBe(true);
  });

  it("an undeliverable notification fails permanently and is marked failed", async () => {
    await withContext(app.db, platform, (tx) =>
      queueNotification(tx, { recipientUserId: A.studentId, schoolId: A.id, channels: ["in_app"], template: "system.test", params: { note: "x" }, dedupeKey: "broken-1" }),
    );
    await owner.db.update(notifications).set({ params: { wrong: true } }).where(eq(notifications.dedupeKey, "broken-1"));
    expect(await work()).toMatchObject({ dead: 1 });
    const [n] = await owner.db.select().from(notifications).where(eq(notifications.dedupeKey, "broken-1"));
    expect(n).toMatchObject({ status: "failed", lastError: "unknown template or invalid parameters" });
    await owner.db.execute(sql`truncate jobs`);
  });

  it("templates validate their parameters and only the sandbox provider exists", () => {
    expect(renderTemplate("system.test", { note: "ok" })?.subject).toBe("Test notification");
    expect(renderTemplate("system.test", { note: 5 })).toBeNull();
    expect(renderTemplate("no.such.template", {})).toBeNull();
    expect(emailAdapterFromEnv(undefined).sandbox).toBe(true);
    expect(emailAdapterFromEnv("sandbox").name).toBe("sandbox");
    expect(() => emailAdapterFromEnv("smtp")).toThrow(/not supported/);
  });

  it("users without an email address get in-app notices only", async () => {
    const [row] = await owner.db.select({ email: users.email }).from(users).where(eq(users.id, A.studentId));
    expect(row!.email).toBeNull();
    const n = await withContext(app.db, platform, (tx) =>
      queueNotification(tx, { recipientUserId: A.studentId, schoolId: A.id, channels: ["in_app", "email"], template: "system.test", params: { note: "x" }, dedupeKey: "no-email" }),
    );
    expect(n).toBe(1);
  });
});
