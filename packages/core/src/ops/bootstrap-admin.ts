import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accountTokens, auditEvents, users, type Db } from "@examio/db";
import { formatCode, generateCode, hashCode } from "../auth/codes";
import { AppError } from "../errors";
import { emailSchema } from "../validation";

/**
 * OPERATOR TOOLING. Not exported from the package index and never used by the web application.
 *
 * Platform administrators cannot be created or promoted through the running application: the
 * runtime database role is forbidden from doing so. An operator with the OWNER database
 * credential runs this instead (`pnpm admin:bootstrap`). It never accepts or prints a password:
 * it issues a one-time code, shown once, and the new administrator chooses their own password
 * at `/redeem`.
 *
 * - "first":      create the first platform administrator; refused if any already exists.
 * - "additional": add another one; refused if none exists yet or the email is already in use.
 * - "recover":    issue a new one-time code for an existing, active platform administrator.
 *
 * An existing account is never promoted.
 */
export type BootstrapMode = "first" | "additional" | "recover";

/** A fresh platform administrator has 24 hours to choose a password. */
export const BOOTSTRAP_CODE_TTL_SECONDS = 24 * 60 * 60;

/** Cannot match any password: verification fails on anything that is not a well-formed hash. */
const UNUSABLE_PASSWORD_HASH = "!";

const inputSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2, "A full name is required.").max(200).optional(),
  mode: z.enum(["first", "additional", "recover"]),
});
export type BootstrapInput = z.input<typeof inputSchema>;

export async function bootstrapPlatformAdmin(
  ownerDb: Db,
  input: BootstrapInput,
): Promise<{ userId: string; mode: BootstrapMode; code: string; expiresAt: Date }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]!.message);
  const { email, fullName, mode } = parsed.data;
  if (mode !== "recover" && !fullName) throw new AppError("VALIDATION", "A full name is required.");

  return ownerDb.transaction(async (tx) => {
    // Serialise concurrent runs so two operators cannot both create the "first" administrator.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('examio.bootstrap_platform_admin'))`);

    const existingAdmins = await tx.select({ id: users.id }).from(users).where(eq(users.isPlatformAdmin, true));
    let userId: string;

    if (mode === "recover") {
      const [admin] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.isPlatformAdmin, true), eq(users.status, "active")));
      if (!admin) throw new AppError("NOT_FOUND", "No active platform administrator has that email address.");
      userId = admin.id;
    } else {
      if (mode === "first" && existingAdmins.length > 0) {
        throw new AppError("CONFLICT", "A platform administrator already exists. Use --additional to add another, or --recover to issue a new code.");
      }
      if (mode === "additional" && existingAdmins.length === 0) {
        throw new AppError("CONFLICT", "No platform administrator exists yet. Run without --additional to create the first one.");
      }
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (taken) throw new AppError("CONFLICT", "That email address already belongs to an account. Existing accounts are never promoted.");
      const [created] = await tx
        .insert(users)
        .values({ fullName: fullName!, email, passwordHash: UNUSABLE_PASSWORD_HASH, isPlatformAdmin: true })
        .returning({ id: users.id });
      if (!created) throw new Error("platform administrator was not created");
      userId = created.id;
    }

    await tx
      .update(accountTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(accountTokens.userId, userId), sql`${accountTokens.consumedAt} is null`, sql`${accountTokens.revokedAt} is null`));

    const code = generateCode();
    const [token] = await tx
      .insert(accountTokens)
      .values({
        userId,
        purpose: mode === "recover" ? "password_reset" : "activation",
        tokenHash: hashCode(code),
        expiresAt: sql`now() + make_interval(secs => ${BOOTSTRAP_CODE_TTL_SECONDS}::integer)`,
      })
      .returning({ expiresAt: accountTokens.expiresAt });
    if (!token) throw new Error("activation code was not created");

    await tx.insert(auditEvents).values({
      action: mode === "first" ? "platform_admin.bootstrapped" : mode === "additional" ? "platform_admin.added" : "platform_admin.recovery_code_issued",
      entityType: "user",
      entityId: userId,
      data: { via: "operator" },
    });

    return { userId, mode, code: formatCode(code), expiresAt: token.expiresAt };
  });
}
