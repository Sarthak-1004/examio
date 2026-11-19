import { expect, test, type Page } from "@playwright/test";
import { signIn, signOut } from "./helpers";

/**
 * Phases 14.4-14.5: finance prepares payroll, a different person (the principal) approves it,
 * payments are recorded, the bank file downloads, and the teacher sees their own payslip. Uses the month three months back so it never meets
 * the month used by staff-payroll.spec.ts.
 */
const adminOf = (name: string) => (name === "desktop" ? "principal@gvps.demo" : "principal@srv.demo");

async function redeem(page: Page, code: string, password: string) {
  await page.goto("/redeem");
  await page.getByLabel("Code from your school").fill(code);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
}

function monthsBack(n: number): string {
  const now = new Date(Date.now() + 5.5 * 3600_000);
  now.setUTCDate(1);
  now.setUTCMonth(now.getUTCMonth() - n);
  return now.toISOString().slice(0, 7);
}

async function addStaff(page: Page, name: string, employeeNo: string, email: string, role: "teacher" | "finance"): Promise<string> {
  await page.goto("/school/staff", { waitUntil: "networkidle" });
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add staff member" }) });
  await form.getByLabel("Full name", { exact: true }).fill(name);
  await form.getByLabel("Employee number", { exact: true }).fill(employeeNo);
  await form.getByLabel("Email", { exact: true }).fill(email);
  await form.getByLabel("Role", { exact: true }).selectOption(role);
  await form.getByRole("button", { name: "Add staff member" }).click();
  return (await page.getByTestId("one-time-code").innerText()).trim();
}

test("finance prepares payroll, another person approves it, payments are recorded and the bank file downloads", async ({ page }, info) => {
  const tag = `${info.project.name[0]}${Date.now().toString(36).slice(-5)}`;
  const month = monthsBack(3);
  const financeEmail = `clerk-${tag}@pay.demo`;

  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  const code = await addStaff(page, `Clerk ${tag}`, `FN-${tag}`, financeEmail, "finance");
  const meenaCode = await addStaff(page, `Meena ${tag}`, `PA-${tag}`, `meena-${tag}@pay.demo`, "teacher");
  await page.goto("/school/payroll/salaries", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: `Meena ${tag} (PA-${tag})` }).click();
  await expect(page.getByRole("heading", { name: `Meena ${tag}` })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Effective from").fill("2024-01-01");
  await page.getByLabel("Monthly basic (₹)").fill("20000");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByRole("heading", { name: "From 2024-01-01" })).toBeVisible();
  await signOut(page);

  // Finance prepares and calculates; they cannot approve.
  await redeem(page, code, "Clerk#Payroll26");
  await signIn(page, financeEmail, "Clerk#Payroll26");
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/school/payroll", { waitUntil: "networkidle" });
  await page.getByLabel("Month", { exact: true }).fill(month);
  await page.getByRole("button", { name: "Start and calculate" }).click();
  await expect(page.getByRole("heading", { name: /^Payroll for / })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `Meena ${tag}` })).toBeVisible();
  await expect(page.getByText("A school administrator approves payroll.")).toBeVisible();
  const runUrl = page.url();
  await signOut(page);

  // The principal approves, records payment and downloads the bank file.
  await signIn(page, adminOf(info.project.name), "Demo@1234");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto(runUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve and lock" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Bank reference").fill(`NEFT-${tag}`);
  await page.getByRole("button", { name: "Mark all unpaid as paid" }).click();
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
  const bank = await page.request.get(`${new URL(runUrl).pathname}/bank`);
  expect(bank.status()).toBe(200);
  expect(await bank.text()).toContain(`PA-${tag},Meena ${tag},,,,20000.00`);

  await page.getByRole("link", { name: `Meena ${tag} (PA-${tag})` }).click();
  await expect(page.getByRole("heading", { name: /^Payslip for / })).toBeVisible();
  await expect(page.getByText(`reference NEFT-${tag}`)).toBeVisible();
  await signOut(page);

  // Phase 14.5: the teacher sees their own payslip, and only theirs.
  await redeem(page, meenaCode, "Meena#Payslip26");
  await signIn(page, `meena-${tag}@pay.demo`, "Meena#Payslip26");
  await expect(page).toHaveURL(/\/school$/);
  await page.goto("/school/my-payslips", { waitUntil: "networkidle" });
  await expect(page.getByRole("row")).toHaveCount(2); // header and this month's payslip
  await page.getByRole("link", { name: /^\w+ \d{4}$/ }).click();
  await expect(page.getByRole("heading", { name: /^Payslip for / })).toBeVisible();
  await expect(page.getByText(`PA-${tag}`, { exact: true })).toBeVisible();
  expect((await page.request.get(`${new URL(runUrl).pathname}/bank`)).status()).toBe(403);
});
