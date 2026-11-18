import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phase 12: offline (paper) marks and results. Runs after setup.spec.ts (files run in name order
 * with one worker): "Class 1 A" with Mathematics and the CBSE-style default grading scheme exist.
 */
const school = (name: string) => (name === "desktop" ? { admin: "principal@gvps.demo", code: "gvps" } : { admin: "principal@srv.demo", code: "srv" });

async function redeem(page: Page, code: string, password: string) {
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
}

test("an administrator records paper exam marks, locks and releases them; the student sees the report card", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const s = school(info.project.name);
  const admission = `RS-${tag}`;
  const username = `${s.code}.${admission.toLowerCase()}`;
  const title = `Paper test ${tag}`;

  await signIn(page, s.admin, "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/students", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Ira ${tag}`);
  await page.getByLabel("Admission number", { exact: true }).fill(admission);
  await page.getByLabel("Class and section").selectOption({ label: "Class 1 A" });
  await page.getByRole("button", { name: "Admit student" }).click();
  const code = (await page.getByTestId("one-time-code").innerText()).trim();

  // Define the paper exam.
  await page.goto("/school/results", { waitUntil: "networkidle" });
  const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Create" }) });
  await create.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await create.getByLabel("Title").fill(title);
  await create.getByLabel("Maximum marks").fill("50");
  await create.getByRole("checkbox", { name: "Class 1 A" }).check();
  await create.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Locking needs every student: everyone else in the class is marked absent, our student 42.
  const register = page.locator("form").filter({ has: page.getByRole("button", { name: "Save Class 1 A" }) });
  const inputs = register.locator("input[name^='v:']");
  for (let i = 0, n = await inputs.count(); i < n; i++) await inputs.nth(i).fill("AB");
  await register.getByLabel(new RegExp(`Ira ${tag}`)).fill("42");
  await register.getByRole("button", { name: "Save Class 1 A" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Saved \d+ entr/ })).toBeVisible();
  await page.getByRole("button", { name: "Lock marks" }).click();
  await expect(page.getByText("Locked", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Release marks" }).click();
  await expect(page.getByText("Released", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `Ira ${tag}` }).getByText("84.00%")).toBeVisible();
  await signOut(page);

  // The student sees it on their report card.
  await redeem(page, code, "Ira#Learn2026");
  await signIn(page, username, "Ira#Learn2026");
  await expect(page).toHaveURL(/\/student$/);
  await page.goto("/student/results");
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row.getByText("42 / 50")).toBeVisible();
  await expect(row.getByText("84.00%")).toBeVisible();
  await expect(row.getByText("A2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeVisible();
});
