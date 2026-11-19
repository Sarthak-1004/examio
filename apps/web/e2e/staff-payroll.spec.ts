import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/** Phase 14.3: payroll calculation. Independent of other specs except the demo schools and their admins. */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

/** Last month as YYYY-MM (India time). */
function lastMonth(): string {
  const now = new Date(Date.now() + 5.5 * 3600_000);
  now.setUTCDate(1);
  now.setUTCMonth(now.getUTCMonth() - 1);
  return now.toISOString().slice(0, 7);
}

test("an administrator defines a component, records a salary and calculates a month's payroll", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/staff", { waitUntil: "networkidle" });
  await page.getByLabel("Full name", { exact: true }).fill(`Prakash ${tag}`);
  await page.getByLabel("Employee number", { exact: true }).fill(`PY-${tag}`);
  await page.getByLabel("Email", { exact: true }).fill(`prakash-${tag}@pay.demo`);
  await page.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByTestId("one-time-code")).toBeVisible();

  await page.goto("/school/payroll", { waitUntil: "networkidle" });
  await page.getByLabel("Name", { exact: true }).fill(`HRA ${tag}`);
  await page.getByLabel("Calculation").selectOption("percent_basic");
  await page.getByRole("button", { name: "Add component" }).click();
  await expect(page.getByRole("row").filter({ hasText: `HRA ${tag}` })).toBeVisible();

  await page.goto("/school/payroll/salaries", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: `Prakash ${tag} (PY-${tag})` }).click();
  await expect(page.getByRole("heading", { name: `Prakash ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Effective from").fill("2025-04-01");
  await page.getByLabel("Monthly basic (₹)").fill("25000");
  await page.getByLabel(`HRA ${tag} (%; blank if not paid)`).fill("40");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("heading", { name: "From 2025-04-01" })).toBeVisible();

  await page.goto("/school/payroll", { waitUntil: "networkidle" });
  await page.getByLabel("Month", { exact: true }).fill(lastMonth());
  await page.getByRole("button", { name: "Start and calculate" }).click();
  await expect(page.getByRole("heading", { name: /^Payroll for / })).toBeVisible();
  // Nothing marked: every working day is payable, so basic ₹25,000 + HRA 40% = ₹35,000.
  await expect(page.getByRole("row").filter({ hasText: `Prakash ${tag}` }).getByText("₹35,000.00").last()).toBeVisible(); // net pay; gross is hidden on phones

  // A month has one run.
  await page.goto("/school/payroll", { waitUntil: "networkidle" });
  await page.getByLabel("Month", { exact: true }).fill(lastMonth());
  await page.getByRole("button", { name: "Start and calculate" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already has a payroll run" })).toBeVisible();
});
