import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { totpCode, totpStep } from "../../../packages/core/src/auth/totp";

// Public fixtures created by `pnpm db:seed --e2e` in the disposable browser-test database.
export const SUPER = { id: "admin@examio.local", pw: "ChangeMe!2026", totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" };

export async function signIn(page: Page, id: string, pw: string) {
  await page.goto("/login");
  await page.getByLabel("Email, mobile number or username").fill(id);
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// The last authenticator step used for the platform admin, shared by all test files so a code
// the server has already accepted is never offered again. Cleared by e2e/global-setup.ts,
// because the database is recreated for every run.
const STEP_FILE = path.join(os.tmpdir(), "examio-e2e-super-totp-step");
function readLastStep(): number {
  try {
    return Number(fs.readFileSync(STEP_FILE, "utf8")) || 0;
  } catch {
    return 0;
  }
}

/**
 * Signs in the platform admin, including the authenticator step. The server accepts each
 * 30-second code once, so consecutive sign-ins use the next step and wait when they must.
 */
export async function signInSuper(page: Page) {
  await signIn(page, SUPER.id, SUPER.pw);
  await expect(page).toHaveURL(/\/mfa$/);
  for (let attempt = 0; attempt < 3; attempt++) {
    const step = Math.max(totpStep(), readLastStep() + 1);
    // A code one step ahead is still accepted; anything further must wait for the clock.
    const waitMs = (step - 1) * 30_000 - Date.now();
    if (waitMs > 0) await page.waitForTimeout(waitMs + 250);
    fs.writeFileSync(STEP_FILE, String(step));
    await page.getByLabel("Code from your authenticator app").fill(totpCode(SUPER.totpSecret, step));
    await page.getByRole("button", { name: "Verify" }).click();
    try {
      await expect(page).toHaveURL(/\/admin$/, { timeout: 5000 });
      return;
    } catch {
      // Code already used: move on to the next step.
    }
  }
  await expect(page).toHaveURL(/\/admin$/);
}

export async function signOut(page: Page) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Sign out", exact: true }).last().click();
  await expect(page).toHaveURL(/\/login$/);
}
