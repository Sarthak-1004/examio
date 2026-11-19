import { expect, test } from "@playwright/test";
import { totpCode, totpStep } from "../../../packages/core/src/auth/totp";
import { SUPER, signIn, signInSuper, signOut } from "./helpers";

test("unauthenticated users are sent to sign-in", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
});

test("wrong password shows an error", async ({ page }) => {
  await signIn(page, SUPER.id, "wrong-password");
  await expect(page.getByRole("alert").filter({ hasText: "Incorrect login or password" })).toBeVisible();
});

test("super admin creates a school; new principal must set a password, then sees only their school", async ({ page }, info) => {
  const code = `e2e${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const adminEmail = `principal@${code}.demo`;

  await signInSuper(page);
  await expect(page.getByRole("heading", { name: "Schools" })).toBeVisible();

  await page.goto("/admin/schools/new");
  await page.getByLabel("School name").fill(`E2E Test School ${code}`);
  await page.getByLabel("School code").fill(code);
  await page.getByLabel("Board").selectOption({ label: "CBSE" });
  await page.getByLabel("Medium of instruction").selectOption({ label: "Marathi" });
  await page.getByLabel("Full name").fill("Priya Kulkarni");
  await page.getByLabel("Email", { exact: true }).fill(adminEmail);
  await page.getByLabel("Temporary password").fill("TempPass#2026");
  await page.getByRole("button", { name: "Create school" }).click();

  await expect(page.getByText("School created.")).toBeVisible();
  await expect(page.getByRole("heading", { name: `E2E Test School ${code}` })).toBeVisible();
  await expect(page.getByText("Marathi")).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible(); // the status (the subscription panel also says Active)

  // Duplicate code is rejected with a friendly message.
  await page.goto("/admin/schools/new");
  await page.getByLabel("School name").fill("Duplicate");
  await page.getByLabel("School code").fill(code);
  await page.getByLabel("Board").selectOption({ label: "CBSE" });
  await page.getByLabel("Medium of instruction").selectOption({ label: "English" });
  await page.getByLabel("Full name").fill("Someone Else");
  await page.getByLabel("Email", { exact: true }).fill(`other@${code}.demo`);
  await page.getByLabel("Temporary password").fill("TempPass#2026");
  await page.getByRole("button", { name: "Create school" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already taken" })).toBeVisible();

  await signOut(page);

  // New principal signs in → forced password change → school dashboard.
  await signIn(page, adminEmail, "TempPass#2026");
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByLabel("Current password").fill("TempPass#2026");
  await page.getByLabel("New password", { exact: true }).fill("MyOwnPass#1");
  await page.getByLabel("Confirm new password").fill("MyOwnPass#1");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page).toHaveURL(/\/school/);
  await expect(page.getByText("Your password has been changed.")).toBeVisible();
  await expect(page.getByText("CBSE · Marathi medium")).toBeVisible();

  // School admin cannot reach platform admin pages.
  await page.goto("/admin");
  await expect(page).not.toHaveURL(/\/admin/);
});

test("demo school admin can sign in with mobile number", async ({ page }) => {
  await signIn(page, "+91 90000 00002", "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await expect(page.getByRole("heading", { name: "Welcome, Rakesh" })).toBeVisible();
});

test("platform admin issues a one-time reset code; the principal sets a new password with it", async ({ page }, info) => {
  const code = `rst${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const adminEmail = `principal@${code}.demo`;

  await signInSuper(page);
  await page.goto("/admin/schools/new");
  await page.getByLabel("School name").fill(`Reset Test School ${code}`);
  await page.getByLabel("School code").fill(code);
  await page.getByLabel("Board").selectOption({ label: "CBSE" });
  await page.getByLabel("Medium of instruction").selectOption({ label: "English" });
  await page.getByLabel("Full name").fill("Meera Joshi");
  await page.getByLabel("Email", { exact: true }).fill(adminEmail);
  await page.getByLabel("Temporary password").fill("TempPass#2026");
  await page.getByRole("button", { name: "Create school" }).click();
  await expect(page.getByText("School created.")).toBeVisible();

  // A reason is required, and the code is shown once.
  await page.getByText("Reset password…").click();
  await page.getByLabel("Reason", { exact: true }).fill("Principal phoned from the registered school number");
  await page.getByRole("button", { name: "Create reset code" }).click();
  const issued = page.getByRole("status").filter({ hasText: "One-time code for Meera Joshi" });
  await expect(issued).toBeVisible();
  const resetCode = (await issued.innerText()).match(/[0-9A-Z]{4}(?:-[0-9A-Z]{4}){3}/)?.[0];
  expect(resetCode).toBeTruthy();
  await signOut(page);

  // A wrong code is refused without saying why.
  await page.goto("/login");
  await page.getByRole("link", { name: "I have a code from my school" }).click();
  await expect(page).toHaveURL(/\/redeem$/);
  await page.getByLabel("Code from your school").fill("AAAA-BBBB-CCCC-DDDD");
  await page.getByLabel("New password", { exact: true }).fill("Principal#New1");
  await page.getByLabel("Confirm new password").fill("Principal#New1");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This code is not valid" })).toBeVisible();

  // The real code works once, typed in lower case without hyphens.
  await page.getByLabel("Code from your school").fill(resetCode!.replace(/-/g, "").toLowerCase());
  await page.getByLabel("New password", { exact: true }).fill("Principal#New1");
  await page.getByLabel("Confirm new password").fill("Principal#New1");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await expect(page.getByText("Your password is set.")).toBeVisible();

  // The temporary password no longer works; the new one does, with no forced change.
  await signIn(page, adminEmail, "TempPass#2026");
  await expect(page.getByRole("alert").filter({ hasText: "Incorrect login or password" })).toBeVisible();
  await signIn(page, adminEmail, "Principal#New1");
  await expect(page).toHaveURL(/\/school/);

  // The principal turns on two-step sign-in (optional for school admins).
  await page.goto("/mfa/setup");
  await page.getByRole("button", { name: "Start setup" }).click();
  const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByLabel("Code from the app").fill("000000");
  await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code is not correct" })).toBeVisible();
  const enrolStep = totpStep();
  await page.getByLabel("Code from the app").fill(totpCode(secret, enrolStep));
  await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await expect(page.getByText("Two-step sign-in is on.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Backup codes" }).getByRole("listitem")).toHaveCount(10);
  await page.getByRole("link", { name: "I have saved my backup codes" }).click();
  await expect(page).toHaveURL(/\/school/);
  await signOut(page);

  // Now the password alone is not enough, and a used code is refused.
  await signIn(page, adminEmail, "Principal#New1");
  await expect(page).toHaveURL(/\/mfa$/);
  await page.goto("/school");
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, adminEmail, "Principal#New1");
  await page.getByLabel("Code from your authenticator app").fill(totpCode(secret, enrolStep));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code is not correct" })).toBeVisible();
  await page.getByLabel("Code from your authenticator app").fill(totpCode(secret, enrolStep + 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/school/);
  await signOut(page);

  // The used code cannot be replayed.
  await page.goto(`/redeem?code=${resetCode}`);
  await expect(page.getByLabel("Code from your school")).toHaveValue(resetCode!);
  await page.getByLabel("New password", { exact: true }).fill("Attacker#Pass1");
  await page.getByLabel("Confirm new password").fill("Attacker#Pass1");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This code is not valid" })).toBeVisible();
});

test("platform admin opens and ends audited support access for a school", async ({ page }) => {
  await signInSuper(page);
  await page.getByRole("link", { name: "Green Valley Public School" }).first().click();
  await expect(page.getByRole("heading", { name: "Green Valley Public School" })).toBeVisible();

  // Leave a clean state if an earlier run stopped half way.
  const end = page.getByRole("button", { name: "End access now" });
  if (await end.isVisible()) await end.click();

  // A reason must say something: padding with spaces gets past the browser but not the server.
  await page.getByLabel("Reason for access").fill("help".padEnd(14, " "));
  await page.getByRole("button", { name: "Open access for 1 hour" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Describe why access is needed" })).toBeVisible();

  const reason = `E2E check ${Date.now().toString(36)}: principal asked for help with a teacher account`;
  await page.getByLabel("Reason for access").fill(reason);
  await page.getByRole("button", { name: "Open access for 1 hour" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Access is open until" })).toContainText(reason);

  await page.getByRole("button", { name: "End access now" }).click();
  await expect(page.getByLabel("Reason for access")).toBeVisible();
  // The grant stays in the history after it ends.
  await expect(page.getByText(reason)).toBeVisible();
});
