import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq } from "drizzle-orm";
import { assertDisposableDatabase, boards, createDb, mediums, schools, userMfa, users } from "@examio/db";
import { hashPassword } from "../src/auth/password";
import { encryptSecret, resolveMfaKey } from "../src/auth/totp";
import { createSchoolWithAdmin } from "../src/services/schools";

/**
 * DEV seed: lookup lists, the platform super admin and two demo schools.
 * Idempotent — safe to run repeatedly. Uses FAKE data only.
 * `--e2e` seeds the disposable browser-test database instead (E2E_DATABASE_*).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

const e2e = process.argv.includes("--e2e");
const ownerUrl = process.env[e2e ? "E2E_DATABASE_OWNER_URL" : "DATABASE_OWNER_URL"];
const appUrl = process.env[e2e ? "E2E_DATABASE_URL" : "DATABASE_URL"];
if (!ownerUrl || !appUrl) throw new Error(`Set ${e2e ? "E2E_" : ""}DATABASE_OWNER_URL and ${e2e ? "E2E_" : ""}DATABASE_URL (see .env.example).`);
if (e2e) {
  assertDisposableDatabase(ownerUrl, "seed browser-test data into");
  assertDisposableDatabase(appUrl, "seed browser-test data into");
}

const owner = createDb(ownerUrl, { max: 1 });
const app = createDb(appUrl, { max: 2 });

const BOARDS = ["CBSE", "ICSE", "State Board", "IB", "Cambridge (IGCSE)", "NIOS"];
const MEDIUMS = ["English", "Hindi", "Marathi", "Gujarati", "Tamil", "Telugu", "Kannada", "Malayalam", "Bengali", "Urdu"];

await owner.db.insert(boards).values(BOARDS.map((name) => ({ name }))).onConflictDoNothing();
await owner.db.insert(mediums).values(MEDIUMS.map((name) => ({ name }))).onConflictDoNothing();

const email = (process.env.SEED_SUPERADMIN_EMAIL ?? "admin@examio.local").toLowerCase();
const password = process.env.SEED_SUPERADMIN_PASSWORD ?? "ChangeMe!2026";
let [superAdmin] = await owner.db.select().from(users).where(eq(users.email, email));
if (!superAdmin) {
  [superAdmin] = await owner.db
    .insert(users)
    .values({ fullName: "Platform Admin", email, passwordHash: await hashPassword(password), isPlatformAdmin: true })
    .returning();
  console.log(`Created super admin ${email}`);
}

// Platform access needs a confirmed authenticator. The demo admin gets a PUBLIC demo key so
// developers and browser tests can produce codes; add it to an authenticator app by hand.
const demoTotpSecret = process.env.SEED_SUPERADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const mfaKey = resolveMfaKey(process.env.MFA_ENCRYPTION_KEY, false);
const [enrolled] = await owner.db.select().from(userMfa).where(eq(userMfa.userId, superAdmin!.id));
if (!enrolled) {
  await owner.db.insert(userMfa).values({ userId: superAdmin!.id, secretEnc: encryptSecret(mfaKey, demoTotpSecret), confirmedAt: new Date() });
  console.log(`Enrolled demo two-step sign-in for ${email} (authenticator key: ${demoTotpSecret})`);
}

const ctx = { userId: superAdmin!.id, schoolId: null, isPlatformAdmin: true };
const boardId = (n: string) => owner.db.select().from(boards).where(eq(boards.name, n)).then((r) => r[0]!.id);
const mediumId = (n: string) => owner.db.select().from(mediums).where(eq(mediums.name, n)).then((r) => r[0]!.id);

const demo = [
  { name: "Green Valley Public School", code: "gvps", board: "CBSE", medium: "English", admin: { fullName: "Anita Sharma", email: "principal@gvps.demo", phone: "9000000001" } },
  { name: "Sunrise Vidyalaya", code: "srv", board: "State Board", medium: "Hindi", admin: { fullName: "Rakesh Verma", email: "principal@srv.demo", phone: "9000000002" } },
];
for (const s of demo) {
  const exists = await owner.db.select().from(schools).where(eq(schools.code, s.code));
  if (exists.length) continue;
  await createSchoolWithAdmin(app.db, ctx, {
    name: s.name,
    code: s.code,
    boardId: await boardId(s.board),
    mediumId: await mediumId(s.medium),
    admin: { ...s.admin, password: "Demo@1234" },
  });
  await owner.db.update(schools).set({ status: "active" }).where(eq(schools.code, s.code));
  await owner.db.update(users).set({ mustChangePassword: false }).where(eq(users.email, s.admin.email));
  console.log(`Created demo school ${s.name} (admin ${s.admin.email} / Demo@1234)`);
}

await owner.close();
await app.close();
console.log("Seed complete.");
